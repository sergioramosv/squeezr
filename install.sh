#!/usr/bin/env bash
set -e

SQUEEZR_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Installing Squeezr from $SQUEEZR_DIR..."

pip install -r "$SQUEEZR_DIR/requirements.txt"

# Set ANTHROPIC_BASE_URL in shell profile
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
    if ! grep -q "ANTHROPIC_BASE_URL" "$SHELL_RC"; then
        echo "" >> "$SHELL_RC"
        echo "# Squeezr - Claude context compressor" >> "$SHELL_RC"
        echo "export ANTHROPIC_BASE_URL=http://localhost:8080" >> "$SHELL_RC"
        echo "Set ANTHROPIC_BASE_URL in $SHELL_RC"
    else
        echo "ANTHROPIC_BASE_URL already set in $SHELL_RC"
    fi
fi

OS="$(uname -s)"

# ── macOS: launchd ────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.squeezr.plist"
    PYTHON="$(which python3)"
    cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.squeezr</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$SQUEEZR_DIR/main.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.squeezr/squeezr.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.squeezr/squeezr.log</string>
</dict>
</plist>
EOF
    mkdir -p "$HOME/.squeezr"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Auto-start configured via launchd (macOS)."

# ── Linux: systemd user service ───────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then
    SERVICE_DIR="$HOME/.config/systemd/user"
    PYTHON="$(which python3)"
    mkdir -p "$SERVICE_DIR"
    cat > "$SERVICE_DIR/squeezr.service" << EOF
[Unit]
Description=Squeezr Claude Context Compressor

[Service]
ExecStart=$PYTHON $SQUEEZR_DIR/main.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable squeezr
    systemctl --user start squeezr
    echo "Auto-start configured via systemd (Linux)."
fi

echo ""
echo "Done. Squeezr is running."
echo "Restart your terminal or run: source $SHELL_RC"
