#!/bin/bash
# uninstall-autostart.sh
# Removes the AiroDrop systemd user service.

SERVICE_FILE="$HOME/.config/systemd/user/airodrop.service"

if [ -f "$SERVICE_FILE" ]; then
    systemctl --user stop airodrop.service 2>/dev/null
    systemctl --user disable airodrop.service 2>/dev/null
    rm "$SERVICE_FILE"
    systemctl --user daemon-reload
    echo ""
    echo " [SUCCESS] AiroDrop autostart service removed."
    echo ""
else
    echo ""
    echo " [INFO] No autostart service file found. Nothing to remove."
    echo ""
fi
