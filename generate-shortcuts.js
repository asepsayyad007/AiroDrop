/**
 * generate-shortcuts.js — Generates .shortcut files for direct iOS import
 *
 * Usage: node generate-shortcuts.js <server-url>
 * Example: node generate-shortcuts.js http://192.168.1.42:3478
 *
 * Produces:
 *   shortcuts/Send-to-PC.shortcut  (Share Sheet: images + text + URLs)
 *   shortcuts/Send-Clipboard.shortcut (Home Screen: one-tap clipboard send)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SERVER_URL = process.argv[2] || 'http://192.168.1.42:3478';

// ─── Ensure output dir ────────────────────────────────────────
const outDir = path.join(__dirname, 'public', 'shortcuts');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════
// Shortcut Definition Builder
// ═══════════════════════════════════════════════════════════════

function buildShortcut(actions, options = {}) {
  return {
    WFWorkflowActions: actions,
    WFWorkflowHasShortcutInputVariables: options.hasInput ?? true,
    WFWorkflowTypes: options.workflowTypes || 'WFContentItemTypeGeneric',
    WFWorkflowInputVariables: options.inputVariables || [],
    WFWorkflowNoInputBehavior: options.noInputBehavior || { WFWorkflowNoInputBehaviorActionName: 'Do Nothing' }
  };
}

// ─── Action: Get Contents of URL (POST) ───────────────────────
function httpPost(url, bodyType, bodyValue, fieldName = 'image') {
  const params = {
    WFURLActionURL: { Value: url, WFSerializationType: 'WFTextTokenAttachment' },
    WFHTTPMethod: 'POST'
  };

  if (bodyType === 'file') {
    // Send Shortcut Input as file upload
    params.WFRequestVariable = {
      VariableName: 'Shortcut Input',
      WFSerializationType: 'WFTextTokenAttachment',
      WFVariableAggregationStyle: 'Latest'
    };
    params.WFHTTPBodyType = 'File';
  } else if (bodyType === 'json') {
    params.WFHTTPBodyType = 'JSON';
    params.WFHTTPBody = { Value: bodyValue, WFSerializationType: 'WFTextTokenAttachment' };
  } else if (bodyType === 'form') {
    params.WFHTTPBodyType = 'Form';
    params.WFFormValues = { Value: bodyValue, WFSerializationType: 'WFDictionaryFieldValue' };
  }

  return {
    WFWorkflowActionIdentifier: 'is.workflow.actions.getcontents_of_url',
    WFWorkflowActionParameters: params
  };
}

// ─── Action: Set Variable ─────────────────────────────────────
function setVariable(name, value) {
  return {
    WFWorkflowActionIdentifier: 'is.workflow.actions.setvariable',
    WFWorkflowActionParameters: {
      WFVariableName: name,
      WFVariableValue: { Value: value, WFSerializationType: 'WFTextTokenAttachment' }
    }
  };
}

// ─── Action: Get Variable ─────────────────────────────────────
function getVariable(name) {
  return {
    WFWorkflowActionIdentifier: 'is.workflow.actions.getvariable',
    WFWorkflowActionParameters: {
      WFVariableName: name,
      WFVariableAggregationStyle: 'Latest'
    }
  };
}

// ─── Action: Get Clipboard ────────────────────────────────────
function getClipboard() {
  return {
    WFWorkflowActionIdentifier: 'is.workflow.actions.getclipboard',
    WFWorkflowActionParameters: {}
  };
}

// ─── Action: Conditional (If) ─────────────────────────────────
function conditional(conditionType, conditionParameter, thenActions, elseActions) {
  const params = {
    WFConditionalActionParameter: { Value: JSON.stringify({ type: conditionType, parameter: conditionParameter }) },
    WFControlFlowMode: 0
  };

  const groups = [];

  // Group 0 = Then
  groups.push({
    WFWorkflowActionIdentifier: 'is.workflow.actions.conditional',
    WFWorkflowActionParameters: {
      ...params,
      GroupingIdentifier: 'then',
      WFControlFlowMode: 2
    },
    WFWorkflowActionNextActions: thenActions || []
  });

  // Group 1 = Else
  if (elseActions && elseActions.length > 0) {
    groups.push({
      WFWorkflowActionIdentifier: 'is.workflow.actions.conditional',
      WFWorkflowActionParameters: {
        ...params,
        GroupingIdentifier: 'else',
        WFControlFlowMode: 3
      },
      WFWorkflowActionNextActions: elseActions || []
    });
  }

  const rootConditional = {
    WFWorkflowActionIdentifier: 'is.workflow.actions.conditional',
    WFWorkflowActionParameters: {
      ...params,
      WFControlFlowMode: 0,
      WFConditionalActionParameter: {
        Value: { type: conditionType, parameter: conditionParameter },
        WFSerializationType: 'WFConditionalActionParameter'
      }
    }
  };

  // Use the then actions as next actions from the conditional root
  // and include the else group after
  if (elseActions && elseActions.length > 0) {
    rootConditional.WFWorkflowActionNextActions = thenActions;
    rootConditional.WFWorkflowActionElseActions = elseActions;
  } else {
    rootConditional.WFWorkflowActionNextActions = thenActions;
  }

  return rootConditional;
}

// ─── Action: Show Notification ────────────────────────────────
function showNotification(title, body) {
  return {
    WFWorkflowActionIdentifier: 'is.workflow.actions.shownotification',
    WFWorkflowActionParameters: {
      WFNotificationActionTitle: { Value: title, WFSerializationType: 'WFTextTokenAttachment' },
      WFNotificationActionBody: { Value: body, WFSerializationType: 'WFTextTokenAttachment' }
    }
  };
}

// ─── Action: Get Shortcut Input ───────────────────────────────
function getShortcutInput() {
  return {
    WFWorkflowActionIdentifier: 'is.workflow.actions.getshortcutinput',
    WFWorkflowActionParameters: {
      WFShortcutInputType: 'WFContentItemTypeGeneric'
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// Generate Shortcut 1: "Send to PC" (Share Sheet)
// ═══════════════════════════════════════════════════════════════

function generateSendToPC() {
  // This shortcut accepts ANY input (image, text, URL) from Share Sheet
  // and sends it to the unified /api/send endpoint

  const actions = [
    // Step 1: Send to the unified endpoint
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.getcontents_of_url',
      WFWorkflowActionParameters: {
        WFURLActionURL: {
          Value: `${SERVER_URL}/api/send`,
          WFSerializationType: 'WFTextTokenAttachment'
        },
        WFHTTPMethod: 'POST',
        WFHTTPBodyType: 'Form',
        WFFormValues: {
          Value: JSON.stringify({ content: { Value: 'Shortcut Input', WFSerializationType: 'WFTextTokenAttachment' } }),
          WFSerializationType: 'WFDictionaryFieldValue'
        }
      }
    },
    // Step 2: Show confirmation
    showNotification('Send to PC', 'Sent successfully')
  ];

  return buildShortcut(actions, {
    hasInput: true,
    workflowTypes: 'WFContentItemTypeGeneric'
  });
}

// ═══════════════════════════════════════════════════════════════
// Generate Shortcut 2: "Send Clipboard to PC" (Home Screen)
// ═══════════════════════════════════════════════════════════════

function generateSendClipboard() {
  const actions = [
    // Step 1: Get clipboard content
    getClipboard(),
    // Step 2: Send to server
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.getcontents_of_url',
      WFWorkflowActionParameters: {
        WFURLActionURL: {
          Value: `${SERVER_URL}/api/text`,
          WFSerializationType: 'WFTextTokenAttachment'
        },
        WFHTTPMethod: 'POST',
        WFHTTPBodyType: 'JSON',
        WFHTTPBody: {
          Value: '{"text": "Clipboard"}',
          WFSerializationType: 'WFTextTokenAttachment'
        }
      }
    },
    // Step 3: Show confirmation
    showNotification('Send to PC', 'Clipboard sent')
  ];

  return buildShortcut(actions, {
    hasInput: false,
    workflowTypes: 'WFWorkflowRunSourceButton',
    noInputBehavior: { WFWorkflowNoInputBehaviorActionName: 'Do Nothing' }
  });
}

// ═══════════════════════════════════════════════════════════════
// Write .shortcut file (ZIP containing shortcut JSON)
// ═══════════════════════════════════════════════════════════════

function writeShortcutFile(filePath, shortcutDef) {
  const json = JSON.stringify(shortcutDef, null, 2);

  // iOS shortcut files are ZIP archives
  // Use built-in ZIP creation (no external deps needed)
  createSimpleZip(filePath, json);
}

function createSimpleZip(filePath, content) {
  // Create a minimal valid ZIP file manually
  const contentBuf = Buffer.from(content, 'utf8');

  // Using Node.js zlib for raw deflate (ZIP uses raw deflate, not zlib-wrapped)
  const compressed = zlib.deflateRawSync(contentBuf, { level: 9 });

  // Build ZIP file structure
  const name = 'shortcut.json';
  const nameBuf = Buffer.from(name, 'utf8');

  // Local file header (30 + filename)
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);  // Local file header signature
  localHeader.writeUInt16LE(20, 4);           // Version needed
  localHeader.writeUInt16LE(0, 6);            // General purpose bit flag
  localHeader.writeUInt16LE(8, 8);            // Compression method (deflate)
  localHeader.writeUInt16LE(dosTime, 10);     // Last mod time
  localHeader.writeUInt16LE(dosDate, 12);     // Last mod date
  localHeader.writeUInt32LE(0, 14);           // CRC-32
  localHeader.writeUInt32LE(compressed.length, 18);  // Compressed size
  localHeader.writeUInt32LE(contentBuf.length, 22);  // Uncompressed size
  localHeader.writeUInt16LE(nameBuf.length, 26);    // File name length
  localHeader.writeUInt16LE(0, 28);           // Extra field length

  // Calculate CRC-32
  const crc32 = computeCRC32(contentBuf);

  // Re-write CRC in header
  localHeader.writeUInt32LE(crc32, 14);

  // Central directory header (46 + filename)
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);  // Central dir signature
  centralHeader.writeUInt16LE(20, 4);           // Version made by
  centralHeader.writeUInt16LE(20, 6);           // Version needed
  centralHeader.writeUInt16LE(0, 8);            // General purpose bit flag
  centralHeader.writeUInt16LE(8, 10);           // Compression method
  centralHeader.writeUInt16LE(dosTime, 12);     // Last mod time
  centralHeader.writeUInt16LE(dosDate, 14);     // Last mod date
  centralHeader.writeUInt32LE(crc32, 16);       // CRC-32
  centralHeader.writeUInt32LE(compressed.length, 20);  // Compressed size
  centralHeader.writeUInt32LE(contentBuf.length, 24);  // Uncompressed size
  centralHeader.writeUInt16LE(nameBuf.length, 28);    // File name length
  centralHeader.writeUInt16LE(0, 30);           // Extra field length
  centralHeader.writeUInt16LE(0, 32);           // File comment length
  centralHeader.writeUInt16LE(0, 34);           // Disk number start
  centralHeader.writeUInt16LE(0, 36);           // Internal file attributes
  centralHeader.writeUInt32LE(0, 38);           // External file attributes
  centralHeader.writeUInt32LE(0, 42);           // Relative offset of local header

  // End of central directory record (22)
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);       // End of central dir signature
  endRecord.writeUInt16LE(0, 4);                // Number of this disk
  endRecord.writeUInt16LE(0, 6);                // Disk where central dir starts
  endRecord.writeUInt16LE(1, 8);                // Number of central dir records on this disk
  endRecord.writeUInt16LE(1, 10);               // Total number of central dir records
  endRecord.writeUInt32LE(centralHeader.length + nameBuf.length, 12); // Size of central directory
  endRecord.writeUInt32LE(localHeader.length + nameBuf.length + compressed.length, 16); // Offset of start of central dir
  endRecord.writeUInt16LE(0, 20);               // Comment length

  // Concatenate all parts
  const zip = Buffer.concat([
    localHeader,
    nameBuf,
    compressed,
    centralHeader,
    nameBuf,
    endRecord
  ]);

  fs.writeFileSync(filePath, zip);
}

// CRC-32 implementation
function computeCRC32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

console.log(`Generating shortcuts for ${SERVER_URL}...`);

const sendToPC = generateSendToPC();
const sendClipboard = generateSendClipboard();

const sendToPCPath = path.join(outDir, 'Send-to-PC.shortcut');
const sendClipboardPath = path.join(outDir, 'Send-Clipboard.shortcut');

writeShortcutFile(sendToPCPath, sendToPC);
writeShortcutFile(sendClipboardPath, sendClipboard);

console.log(`  Created: ${sendToPCPath}`);
console.log(`  Created: ${sendClipboardPath}`);
console.log(`  Server URL: ${SERVER_URL}`);
console.log('Done!');