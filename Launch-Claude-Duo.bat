@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
start "" /d "%~dp0dist\Claude-Duo-win32-x64" "%~dp0dist\Claude-Duo-win32-x64\Claude-Duo.exe"
