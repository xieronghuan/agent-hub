@echo off
setlocal
rem ============================================================
rem  Agent Hub launcher
rem  Opens the hub window; closing it stops everything.
rem  ASCII only inside this file (cmd reads it as GBK).
rem ============================================================
set "HERE=%~dp0"
rem Some hosts export ELECTRON_RUN_AS_NODE=1, which turns Electron into plain
rem Node and breaks require('electron'). Clear it for this process tree.
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON=%HERE%app\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo [ERROR] Electron not found at:
  echo         %ELECTRON%
  echo         Run "npm install" inside the app folder first.
  pause
  exit /b 1
)

"%ELECTRON%" "%HERE%app"
endlocal
