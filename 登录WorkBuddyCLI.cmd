@echo off
setlocal
rem ============================================================
rem  WorkBuddy CLI login helper
rem  The relay needs a logged-in CLI to actually run agents.
rem  Without it, session/new returns "Authentication required"
rem  and the agent never produces any output.
rem ============================================================
rem ---- auto-detect node (WorkBuddy bundles one; do not hardcode user/version) ----
set "NODE="
set "NODEBASE=%USERPROFILE%\.workbuddy\binaries\node\versions"
for /f "delims=" %%d in ('dir /b /ad /o-n "%NODEBASE%\22.*" 2^>nul') do (
  if not defined NODE if exist "%NODEBASE%\%%d\node.exe" set "NODE=%NODEBASE%\%%d\node.exe"
)
if not defined NODE (
  for %%p in (node.exe) do if not defined NODE set "NODE=%%~$PATH:p"
)

rem ---- auto-detect the WorkBuddy CLI (install drive may differ) ----
set "CLI="
for %%r in (C D E F G) do (
  if not defined CLI if exist "%%r:\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy" (
    set "CLI=%%r:\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy"
  )
)

rem Some hosts export this, which turns Electron into plain Node
set "ELECTRON_RUN_AS_NODE="

if not exist "%NODE%" (
  echo [ERROR] node not found:
  echo         %NODE%
  pause
  exit /b 1
)
if not exist "%CLI%" (
  echo [ERROR] WorkBuddy CLI not found:
  echo         %CLI%
  pause
  exit /b 1
)

echo ============================================================
echo   WorkBuddy CLI
echo ------------------------------------------------------------
echo   If it asks you to sign in, follow the prompt / open the
echo   link it prints. When you are logged in you can close the
echo   window - the relay only needs the credential.
echo ============================================================
echo.

"%NODE%" "%CLI%"

echo.
echo [exit] You can close this window now.
pause
