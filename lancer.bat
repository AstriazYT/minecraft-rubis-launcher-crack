@echo off
cd /d "%~dp0"
set PATH=%~dp0node-v20.18.0-win-x64;%PATH%
if not exist node_modules call npm install
call npm start
