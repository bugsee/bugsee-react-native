@echo off
rem react.hermesCommand on Windows, where React Native runs it through
rem "cmd /c". macOS and Linux use hermesc-preserve-js.sh. The work, and its
rem non-zero exit when no bytecode came out, is in hermesc-preserve-js.js.
node "%~dp0hermesc-preserve-js.js" %*
exit /b %ERRORLEVEL%
