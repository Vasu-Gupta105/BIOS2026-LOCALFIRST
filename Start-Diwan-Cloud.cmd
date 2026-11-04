@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Diwan-Cloud.ps1" -Publish
if errorlevel 1 pause
