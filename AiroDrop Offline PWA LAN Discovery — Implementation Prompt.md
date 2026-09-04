# AiroDrop Offline PWA + Automatic LAN IP Discovery

You are working on the existing **AiroDrop** project. Do **not** rebuild the project from scratch. First inspect the existing codebase, architecture, APIs, frontend, backend, PWA configuration, authentication flow, and current networking behavior. Preserve existing functionality and make the smallest clean changes necessary.

## Objective

Implement a robust **offline-capable PWA discovery system** for AiroDrop.

AiroDrop is a self-hosted PC/mobile LAN file-sharing application. The PC/server can have a changing private LAN IP because of DHCP. The PWA should remember the last successfully connected AiroDrop server and automatically try that address first.

If the previous IP no longer works, the PWA should provide a **local-network discovery/fallback mechanism** to find the AiroDrop PC without depending on the public AiroDrop web server or Internet connectivity.

The final experience should be:

```text
User opens AiroDrop PWA
        |
        v
Load completely from local cache if necessary
        |
        v
Try last known AiroDrop IP
        |
   +----+----+
   |         |
FOUND      FAILED
   |         |
   v         v
Connect    Start local discovery
             |
             v
       Find AiroDrop server
             |
             v
       Save new IP
             |
             v
          Connect
```

---

# 1. Important constraints

Before modifying anything:

1. Inspect the entire existing project structure.
2. Identify:
   - frontend framework
   - backend framework
   - existing API routes
   - current AiroDrop server port
   - current PWA/service-worker implementation
   - current authentication mechanism
   - current device/session storage
   - existing WebSocket implementation, if any
   - existing HTTPS configuration
   - existing CORS configuration
3. Do not replace the existing architecture unnecessarily.
4. Do not remove existing AiroDrop features.
5. Do not introduce a new framework unless absolutely necessary.
6. Reuse existing dependencies where possible.
7. Keep the implementation production-oriented.
8. Do not assume that arbitrary LAN IP scanning is allowed by every browser.
9. Treat browser Local Network Access restrictions as a first-class technical constraint.
10. Do not claim that browser-based IP scanning works universally.
11. Build graceful fallbacks.

---

# 2. Desired user experience

## First-time user

The user visits the public AiroDrop web application:

```text
https://<airodop-domain>/
```

They install it as a PWA.

The application should cache everything required for the basic application shell and discovery UI.

The user then uses the installed PWA.

---

# 3. Last-known-IP behavior

After a successful connection to an AiroDrop PC, store:

```json
{
  "host": "192.168.1.20",
  "port": 3000,
  "protocol": "http",
  "deviceName": "Asep-PC",
  "lastSuccessfulConnection": "timestamp"
}
```

Do not hard-code the IP.

The stored information must be dynamically updated whenever the application successfully connects to another AiroDrop server.

Prefer IndexedDB for structured persistent data.

If the existing project already has an appropriate storage abstraction, reuse it.

---

# 4. Application startup logic

Every time the PWA launches:

### Step 1

Load the application shell immediately.

Do not wait for the public Internet.

### Step 2

Read the last known AiroDrop server from local storage/IndexedDB.

### Step 3

Attempt to connect to the last known server.

For example:

```text
http://192.168.1.20:<PORT>/api/discovery
```

or use an appropriate existing health/discovery endpoint.

### Step 4

If successful:

```text
AiroDrop found
Asep-PC
192.168.1.20
```

Continue normally.

### Step 5

If unsuccessful:

Do NOT immediately assume the Internet is unavailable.

Show:

```text
AiroDrop PC not found at the last known address.

Last known address:
192.168.1.20

[ Find AiroDrop ]
[ Enter IP manually ]
```

The user should be able to initiate local discovery.

---

# 5. Create an AiroDrop discovery endpoint

Add a lightweight endpoint to the existing AiroDrop server.

Preferred route:

```text
GET /api/discovery
```

The endpoint must:

- require minimal processing
- not expose sensitive information
- identify the server as AiroDrop
- return the AiroDrop version
- return the server/device name if already available
- return the server port if appropriate
- return a protocol identifier
- optionally return capabilities

Example:

```json
{
  "service": "airodop",
  "name": "Asep-PC",
  "version": "1.0.0",
  "protocol": "http",
  "port": 3000,
  "capabilities": {
    "fileTransfer": true,
    "clipboard": true,
    "media": true
  }
}
```

Do not expose:

- operating-system credentials
- private filesystem paths
- authentication secrets
- tokens
- internal network information beyond what is required for discovery

Use the project's existing naming conventions.

---

# 6. Discovery endpoint requirements

The endpoint must be intentionally recognizable.

The frontend should not treat every responding IP as an AiroDrop server.

A response should be validated.

For example:

```javascript
if (
  response.service === "airodop" &&
  response.version
) {
    // Valid AiroDrop server
}
```

Handle:

- timeout
- connection refused
- malformed response
- HTTP errors
- CORS errors
- Local Network Access permission errors
- HTTPS/HTTP mixed-content restrictions
- server unavailable

without crashing the application.

---

# 7. LAN discovery

Implement a browser-compatible local discovery strategy.

Important:

Do NOT blindly assume that the browser can freely scan:

```text
192.168.1.1
192.168.1.2
...
192.168.1.254
```

Modern browsers restrict private/local network requests.

The implementation must account for:

- Local Network Access permission
- CORS
- Private Network Access behavior where applicable
- secure-context requirements
- mixed-content restrictions
- browser differences
- mobile browser differences
- installed PWA behavior

The discovery feature should be explicitly user-triggerable.

For example:

```text
[ Find AiroDrop ]
```

rather than silently performing an aggressive LAN scan every time the application opens.

---

# 8. Network range detection

If technically possible within the browser environment, determine the local subnet dynamically.

Example:

```text
192.168.1.0/24
```

Do not hard-code:

```text
192.168.1.0/24
```

as the only supported network.

The implementation should be capable of working with networks such as:

```text
192.168.0.0/24
192.168.1.0/24
192.168.10.0/24
10.0.0.0/24
172.16.0.0/24
```

However, if the browser cannot reliably determine the subnet, do not use unreliable hacks.

Instead provide a fallback such as:

```text
Enter AiroDrop PC IP manually
```

---

# 9. Discovery strategy

Implement discovery progressively.

Preferred order:

## Strategy A — Last known IP

Always try this first.

Example:

```text
192.168.1.20:3000
```

This should be fast.

---

## Strategy B — Previously discovered devices

Maintain a small list of recently discovered/trusted AiroDrop devices.

Example:

```json
[
  {
    "name": "Asep-PC",
    "host": "192.168.1.20",
    "port": 3000,
    "lastSeen": "timestamp"
  },
  {
    "name": "Laptop",
    "host": "192.168.1.25",
    "port": 3000,
    "lastSeen": "timestamp"
  }
]
```

Try these before performing broad discovery.

---

## Strategy C — Local discovery

If previous addresses fail, perform browser-compatible LAN discovery.

Use:

- bounded concurrency
- short timeouts
- cancellation
- progress indication
- deduplication
- maximum scan duration

Do NOT create hundreds of simultaneous requests.

For example, use a small concurrency pool.

---

# 10. Discovery UI

Create a clean discovery screen.

Example:

```text
Find AiroDrop

Searching your local network...

192.168.1.0/24

[████████████░░░░░░░░] 60%

Found:

Asep-PC
192.168.1.20
AiroDrop v1.4.0

[ Connect ]
```

If nothing is found:

```text
No AiroDrop server found.

Make sure:

• Your PC is powered on
• AiroDrop is running
• Your phone/PC is connected to the same Wi-Fi/LAN
• Your firewall allows AiroDrop
• AiroDrop is listening on the expected port

[ Scan Again ]
[ Enter IP Manually ]
```

---

# 11. Offline operation

The PWA must be able to load its basic UI when the public server is unreachable.

Implement/review:

- Web App Manifest
- Service Worker
- Cache Storage
- application-shell caching
- IndexedDB/local storage
- offline fallback page

The following should be available offline:

- application shell
- AiroDrop branding
- discovery screen
- last-known server information
- manual IP entry
- local discovery UI
- connection status
- previously stored device information

Do NOT cache sensitive authentication tokens unless the existing security architecture explicitly requires it and securely supports it.

---

# 12. Important distinction

The application being offline from the Internet does NOT mean the device is disconnected from the LAN.

This must work conceptually:

```text
Internet
   X

Router
   |
   +---- Phone/PWA
   |
   +---- PC/AiroDrop
```

The PWA should still attempt to communicate directly with the PC over the local network.

Do not route local discovery through the public AiroDrop server.

---

# 13. Public server independence

Once the PWA has been installed and cached, local discovery must not require:

```text
airodop.com
```

or any external API.

Do not implement:

```text
PWA -> Public Server -> Find PC
```

Instead use:

```text
PWA -> Local Network -> AiroDrop PC
```

The public server is only required for things such as:

- initial application delivery
- application updates
- optional cloud features

Local discovery must remain local.

---

# 14. Security requirements

Do not create an unrestricted network scanner.

The feature should be purpose-built for discovering AiroDrop.

Use:

- HTTPS for the public application
- authenticated APIs where required
- a minimal unauthenticated discovery endpoint
- no sensitive data in discovery responses
- request timeouts
- rate limiting if appropriate
- bounded concurrency
- user-triggered discovery
- clear permission messaging

Do not expose arbitrary proxy functionality.

Do not create an endpoint such as:

```text
/api/proxy?url=<anything>
```

Do not allow the AiroDrop server to become a generic LAN proxy.

---

# 15. CORS and browser networking

Review the existing backend CORS configuration.

The implementation must explicitly handle requests originating from the AiroDrop PWA.

Consider:

```text
Access-Control-Allow-Origin
Access-Control-Allow-Methods
Access-Control-Allow-Headers
```

Do not use:

```text
Access-Control-Allow-Origin: *
```

blindly if the existing authentication model requires credentials.

If browser Local Network Access or related browser permissions are required, implement the correct browser-compatible mechanism.

Document browser limitations rather than attempting unsafe workarounds.

---

# 16. HTTP/HTTPS issue

The public PWA may be:

```text
https://airodop.example
```

while the local AiroDrop server may currently be:

```text
http://192.168.1.20:3000
```

This can cause browser security/mixed-content restrictions.

Investigate this carefully.

Do not simply disable security.

Determine whether the existing AiroDrop architecture should use:

```text
HTTPS on the local AiroDrop server
```

or another browser-compatible approach.

If HTTPS certificates are required, design an appropriate onboarding/trust mechanism rather than telling users to disable browser security.

Document the limitation clearly.

---

# 17. Manual IP fallback

Always provide a manual connection option.

Example:

```text
AiroDrop PC address

IP / Host:
[ 192.168.1.20 ]

Port:
[ 3000 ]

[ Connect ]
```

Validate:

- IPv4
- hostname where supported
- port range
- malformed input

Do not allow arbitrary dangerous URL schemes such as:

```text
file:
javascript:
data:
```

---

# 18. Remember successful connections

Whenever a connection succeeds:

```text
save(host)
save(port)
save(deviceName)
save(lastSuccessfulConnection)
```

Example:

```json
{
  "host": "192.168.1.20",
  "port": 3000,
  "deviceName": "Asep-PC",
  "lastSuccessfulConnection": 1787240000000
}
```

The next startup should use this information.

---

# 19. IP changes

Example scenario:

Initial:

```text
PC = 192.168.1.25
```

PWA stores:

```text
192.168.1.25
```

Later DHCP changes:

```text
PC = 192.168.1.20
```

PWA launches:

```text
Try 192.168.1.25
        |
        X
        |
        v
Local discovery
        |
        v
Found 192.168.1.20
        |
        v
Save 192.168.1.20
```

Next launch:

```text
Try 192.168.1.20
        |
        v
      FOUND
```

No scan should be necessary.

---

# 20. Multiple AiroDrop PCs

The system should support multiple AiroDrop servers.

If discovery finds:

```text
Asep-PC
192.168.1.20

Office-PC
192.168.1.30

Laptop
192.168.1.40
```

display them as selectable devices.

Example:

```text
AiroDrop devices

┌───────────────────────────┐
│ Asep-PC                   │
│ 192.168.1.20              │
│ ● Available               │
│                           │
│ [ Connect ]               │
└───────────────────────────┘

┌───────────────────────────┐
│ Office-PC                 │
│ 192.168.1.30              │
│ ● Available               │
│                           │
│ [ Connect ]               │
└───────────────────────────┘
```

Allow the user to mark a preferred/default device if appropriate.

---

# 21. Service worker requirements

Inspect the existing service worker.

Do not blindly replace it.

Ensure:

1. Application shell is cached.
2. PWA can start without Internet.
3. Static assets are available offline.
4. API requests are not incorrectly cached.
5. Local AiroDrop requests are not intercepted incorrectly.
6. Authentication behavior remains secure.
7. New application versions can update correctly.
8. Old cached versions do not permanently trap users on stale code.

Use appropriate cache versioning.

---

# 22. Offline detection

Do not rely exclusively on:

```javascript
navigator.onLine
```

It only indicates network connectivity at a coarse level.

The real test for AiroDrop availability should be:

```text
Can the PWA reach the AiroDrop endpoint?
```

Therefore distinguish:

```text
Internet unavailable
```

from:

```text
AiroDrop PC unavailable
```

and:

```text
Local network unavailable
```

---

# 23. Timeouts

Do not make the user wait for every failed IP request.

Use short connection/discovery timeouts.

For example, investigate an appropriate timeout around:

```text
300–1000 ms
```

depending on browser behavior.

Do not blindly use these values if testing demonstrates a better configuration.

Make timeouts configurable if appropriate.

---

# 24. Cancellation

The user should be able to stop a discovery scan.

Example:

```text
Searching local network...

[ Stop Search ]
```

Use:

```javascript
AbortController
```

or the project's existing cancellation mechanism where appropriate.

Make sure pending requests are actually cancelled or abandoned safely.

---

# 25. Firewall considerations

Document that Windows/Linux firewall rules may block AiroDrop.

The discovery UI should explain:

```text
If AiroDrop is running but cannot be found:

1. Verify AiroDrop is running.
2. Verify both devices are on the same LAN.
3. Verify the AiroDrop port is listening.
4. Check the operating-system firewall.
5. Check router/client isolation.
```

Do not automatically disable firewalls.

---

# 26. Router isolation

The application should recognize that LAN discovery may fail when:

- Wi-Fi client isolation is enabled
- guest Wi-Fi is being used
- AP isolation is enabled
- devices are on different VLANs/subnets
- firewall rules block client-to-client traffic

Document these conditions.

---

# 27. Testing requirements

Test at minimum:

### Test 1 — Same IP

```text
PC = 192.168.1.20
Stored = 192.168.1.20
```

Expected:

```text
Immediate connection
No scan
```

### Test 2 — IP changed

```text
Stored = 192.168.1.25
Actual = 192.168.1.20
```

Expected:

```text
Old IP fails
Discovery starts
192.168.1.20 found
New IP saved
```

### Test 3 — Internet unavailable

```text
Internet = OFF
LAN = ON
PC = ON
```

Expected:

```text
PWA loads from cache
PWA finds local AiroDrop
```

### Test 4 — PC offline

Expected:

```text
PWA loads
Last IP fails
Discovery finds nothing
Manual IP option available
```

### Test 5 — Multiple PCs

Expected:

```text
All valid AiroDrop servers displayed
```

### Test 6 — Wrong responding device

A random local service should NOT be identified as AiroDrop.

### Test 7 — Browser permission denied

Expected:

```text
Clear explanation
Manual IP option
No application crash
```

### Test 8 — Different subnet

Example:

```text
192.168.1.x
```

vs:

```text
192.168.0.x
```

The application must not incorrectly assume the subnet.

### Test 9 — Mobile PWA

Test installed PWA behavior on supported mobile browsers.

### Test 10 — Desktop PWA

Test installed PWA behavior on Windows/Chrome/Edge or the project's supported desktop browsers.

---

# 28. Do not over-engineer

Do NOT immediately add:

- native Android application
- Electron application
- desktop network scanner
- cloud relay
- WebRTC relay
- external discovery server

unless the browser platform makes the required feature impossible.

First implement the browser/PWA architecture correctly.

If a requirement is impossible due to browser security restrictions, clearly explain the limitation and implement the best fallback.

---

# 29. Code quality

Follow the existing project's coding style.

Use:

- clear function names
- small modules
- reusable discovery functions
- centralized configuration
- typed interfaces if the project uses TypeScript
- proper error handling
- structured logging where appropriate

Avoid:

- duplicated fetch logic
- hard-coded IP addresses
- hard-coded production URLs
- magic ports
- global mutable state
- silent failures

---

# 30. Suggested frontend abstraction

Create an abstraction similar to:

```text
AiroDropDiscovery
```

with responsibilities such as:

```text
getLastKnownServer()
saveServer()
testServer()
discoverServers()
connectToServer()
removeServer()
```

Possible conceptual API:

```javascript
const server = await discovery.getLastKnownServer();

if (server) {
    const available = await discovery.testServer(server);

    if (available) {
        return connect(server);
    }
}

const devices = await discovery.discoverServers();

if (devices.length > 0) {
    return showDevices(devices);
}

return showManualConnection();
```

Adapt this to the actual project's architecture rather than blindly copying it.

---

# 31. Suggested backend abstraction

Create or reuse an AiroDrop discovery service.

Conceptually:

```text
GET /api/discovery
```

should return a small, safe payload.

The backend should not perform LAN scanning itself.

The browser/PWA is the local-network client.

---

# 32. UX states

Implement clear states:

```text
INITIALIZING
```

```text
CONNECTING_TO_LAST_KNOWN_SERVER
```

```text
CONNECTED
```

```text
LAST_SERVER_UNAVAILABLE
```

```text
DISCOVERY_PERMISSION_REQUIRED
```

```text
DISCOVERING
```

```text
DEVICES_FOUND
```

```text
NO_DEVICES_FOUND
```

```text
MANUAL_CONNECTION
```

```text
CONNECTION_ERROR
```

```text
OFFLINE
```

Do not use vague messages such as:

```text
Something went wrong.
```

when a useful technical explanation can be given.

---

# 33. Logging/debug mode

Add useful debug logging behind the project's existing development/debug mechanism.

Example:

```text
[AiroDrop Discovery]
Last known host: 192.168.1.25
Testing server...
Server unavailable
Starting discovery...
Candidate found: 192.168.1.20
AiroDrop identified
Saving server
```

Do not log:

- passwords
- authentication tokens
- session cookies
- private file contents

---

# 34. Documentation

After implementation, update the project documentation.

Document:

1. How PWA discovery works.
2. How last-known IP storage works.
3. How offline mode works.
4. Browser Local Network Access restrictions.
5. CORS requirements.
6. HTTP/HTTPS limitations.
7. Firewall requirements.
8. Router isolation limitations.
9. Manual IP fallback.
10. Supported browsers.
11. Known limitations.

Be honest about browser compatibility.

---

# 35. Deliverables

After implementation, provide:

## A. Architecture summary

Explain:

```text
PWA
 ↓
Service Worker
 ↓
IndexedDB
 ↓
Last Known IP
 ↓
Local Discovery
 ↓
AiroDrop Discovery API
```

## B. Files changed

List every modified/created file.

For each file explain why it changed.

## C. Backend changes

List:

- new endpoint
- response format
- CORS changes
- security changes

## D. Frontend changes

List:

- discovery UI
- startup logic
- storage
- connection manager
- error handling

## E. PWA changes

List:

- manifest
- service worker
- caching
- offline fallback

## F. Browser limitations

Explicitly document what browsers can and cannot do.

## G. Testing results

Report which scenarios were tested successfully.

## H. Remaining limitations

Do not hide unresolved browser/security limitations.

---

# 36. Critical implementation rule

Before writing code, inspect the repository and determine what already exists.

Do not assume:

```text
React
Vite
Node
Express
port 3000
service worker
IndexedDB
```

unless the repository actually uses them.

Use the existing AiroDrop implementation as the source of truth.

If there are multiple possible architectures, choose the one requiring the fewest disruptive changes.

---

# Final goal

The final AiroDrop experience should feel like this:

```text
Install AiroDrop PWA
        ↓
Use AiroDrop normally
        ↓
PC IP = 192.168.1.25
        ↓
PWA remembers it
        ↓
PC receives new DHCP IP
        ↓
PC IP = 192.168.1.20
        ↓
Launch PWA
        ↓
Try 192.168.1.25
        ↓
Failed
        ↓
"Find AiroDrop on this network"
        ↓
Local discovery
        ↓
Found AiroDrop at 192.168.1.20
        ↓
Save 192.168.1.20
        ↓
Connect
        ↓
Next launch:
Try 192.168.1.20 first
```

The key objective is **zero-config recovery from a changed LAN IP while remaining functional when the Internet/public AiroDrop server is unavailable**, within the security limitations imposed by modern browsers.

Do not sacrifice browser security to achieve this behavior. If a browser restriction prevents a particular discovery mechanism, implement a safe fallback and clearly document it.