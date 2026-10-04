CREDS="${PROJECT_DIR}/../credentials.json"
TOKEN='3f2a9c1e-0000-4abc-8def-5ca1ab1e0002'
if [ -z "$TOKEN" ]; then
  TOKEN="$BUGSEE_APP_TOKEN"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$BUGSEE_TOKEN_IOS"
fi
if [ -z "$TOKEN" ] && [ -f "$CREDS" ]; then
  TOKEN=$(/usr/bin/plutil -extract ios raw -o - "$CREDS" 2>/dev/null || true)
fi
if [ -n "$TOKEN" ]; then
  export BUGSEE_APP_TOKEN="$TOKEN"
fi
if [ -z "$BUGSEE_ENDPOINT" ] && [ -f "$CREDS" ]; then
  ENDPOINT=$(/usr/bin/plutil -extract endpoint raw -o - "$CREDS" 2>/dev/null || true)
  if [ -n "$ENDPOINT" ]; then
    export BUGSEE_ENDPOINT="$ENDPOINT"
  fi
fi

# Archive's PATH has no node, and the npm shim's shebang searches PATH.
if [ ! -x "$NODE_BINARY" ]; then
  if [ -f "${PROJECT_DIR}/.xcode.env" ]; then
    . "${PROJECT_DIR}/.xcode.env"
  fi
  if [ -f "${PROJECT_DIR}/.xcode.env.local" ]; then
    . "${PROJECT_DIR}/.xcode.env.local"
  fi
fi
if [ ! -x "$NODE_BINARY" ]; then
  RN_FIND=""
  if [ -n "$REACT_NATIVE_PATH" ] && [ -f "$REACT_NATIVE_PATH/scripts/find-node-for-xcode.sh" ]; then
    RN_FIND="$REACT_NATIVE_PATH/scripts/find-node-for-xcode.sh"
  elif [ -f "${PROJECT_DIR}/../node_modules/react-native/scripts/find-node-for-xcode.sh" ]; then
    RN_FIND="${PROJECT_DIR}/../node_modules/react-native/scripts/find-node-for-xcode.sh"
  fi
  if [ -n "$RN_FIND" ]; then
    NODE_BINARY=$(/bin/bash -c '. "$1" >/dev/null 2>&1; command -v node' _ "$RN_FIND" || true)
  fi
fi
if [ -n "$NODE_BINARY" ] && [ -x "$NODE_BINARY" ]; then
  PATH="$(dirname "$NODE_BINARY"):$PATH"
  export PATH NODE_BINARY
  APP_ROOT="${PROJECT_DIR}/.."
  if [ "$(uname -m)" = "x86_64" ]; then
    NATIVE_PKG="$("$NODE_BINARY" --print "try { const path = require('path'); const appRoot = process.argv[1]; const wrapperPkg = require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] }); const wrapperDir = path.dirname(wrapperPkg); const cliPkg = require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] }); const cliDir = path.dirname(cliPkg); require.resolve('@bugsee/cli-darwin-x64/package.json', { paths: [cliDir] }); } catch (e) { '' }" "$APP_ROOT")"
  else
    NATIVE_PKG="$("$NODE_BINARY" --print "try { const path = require('path'); const appRoot = process.argv[1]; const wrapperPkg = require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] }); const wrapperDir = path.dirname(wrapperPkg); const cliPkg = require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] }); const cliDir = path.dirname(cliPkg); require.resolve('@bugsee/cli-darwin-arm64/package.json', { paths: [cliDir] }); } catch (e) { '' }" "$APP_ROOT")"
  fi
  if [ -n "$NATIVE_PKG" ]; then
    NATIVE_BIN="$(dirname "$NATIVE_PKG")/bin/bugsee-cli"
    if [ -x "$NATIVE_BIN" ]; then
      "$NATIVE_BIN" xcode post-action
      exit $?
    fi
  fi
  CLI_JS="$("$NODE_BINARY" --print "try { const fs = require('fs'); const path = require('path'); const appRoot = process.argv[1]; const wrapperPkg = require.resolve('@bugsee/react-native/package.json', { paths: [appRoot] }); const wrapperDir = path.dirname(wrapperPkg); const cliPkg = require.resolve('@bugsee/cli/package.json', { paths: [wrapperDir] }); const cliDir = path.dirname(cliPkg); const rel = JSON.parse(fs.readFileSync(cliPkg, 'utf8')).bin['bugsee-cli']; rel ? path.join(cliDir, rel) : ''; } catch (e) { '' }" "$APP_ROOT")"
  if [ -n "$CLI_JS" ]; then
    "$NODE_BINARY" "$CLI_JS" xcode post-action
    exit $?
  fi
fi

echo "bugsee-cli: not found" >&2
exit 1
