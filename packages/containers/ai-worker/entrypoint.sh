#!/bin/sh
set -eu

OPENCODE_HOME_DIR="${HOME:-/home/node}"
OPENCODE_DATA_DIR="$OPENCODE_HOME_DIR/.local/share/opencode"
OPENCODE_STATE_DIR="$OPENCODE_HOME_DIR/.local/state"
RUNTIME_OPENCODE_DIR="/workspace/.opencode"
RUNTIME_OPENCODE_PLUGIN_DIR="$RUNTIME_OPENCODE_DIR/plugins"
PREBUILT_OPENCODE_RUNTIME_DIR="/opt/boboddy/opencode-runtime"

mkdir -p "$OPENCODE_DATA_DIR" "$OPENCODE_STATE_DIR" "$RUNTIME_OPENCODE_PLUGIN_DIR"

if [ -f /opencode-host-share/auth.json ]; then
	cp /opencode-host-share/auth.json "$OPENCODE_DATA_DIR/auth.json"
	chmod 600 "$OPENCODE_DATA_DIR/auth.json"
fi

ln -sfn "$PREBUILT_OPENCODE_RUNTIME_DIR/node_modules" "$RUNTIME_OPENCODE_PLUGIN_DIR/node_modules"
cp /opt/boboddy/plugin.js "$RUNTIME_OPENCODE_PLUGIN_DIR/boboddy.js"

exec "$@"
