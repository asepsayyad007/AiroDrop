#!/bin/bash
# install-autostart.sh
# Configures AiroDrop to start automatically on system boot/login using systemd user services (standard on Linux).

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/airodrop.service"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Ensure the directory exists
mkdir -p "$SERVICE_DIR"

# Create the systemd service file
cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=AiroDrop Server Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$(which node) server.js
Restart=on-failure
StandardOutput=append:$SCRIPT_DIR/server.log
StandardError=append:$SCRIPT_DIR/server.log

[Install]
WantedBy=default.target
EOF

# Reload systemd manager configuration for the user
systemctl --user daemon-reload

# Enable and start the service
systemctl --user enable airodrop.service
systemctl --user start airodrop.service

echo ""
echo " [SUCCESS] Auto-start configured for Linux!"
echo " AiroDrop service has been enabled and started."
echo " To check status, run: systemctl --user status airodrop.service"
echo " To stop the service, run: systemctl --user stop airodrop.service"
echo " To view logs: tail -f $SCRIPT_DIR/server.log"
echo " To uninstall autostart, run: ./uninstall-autostart.sh"
echo ""
