@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LocalFirst-Offline.ps1"
if errorlevel 1 pause
