@echo off
rem Kick Overlay auto-install/update for the debug profile.
rem Uses the VOD.RIP UIA installer adapted to C:\ChromeDebugProfile.
rem Requires the debug Chrome to be running (port 9222) or lets the installer spawn it.
setlocal
set "PS=%~dp0ko-auto-install.ps1"
set "EXT=C:\Users\Administrador\Desktop\Nova pasta (3)\TESTE\VOD.RIP\vendor\kick-overlay"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" -ExtensionDir "%EXT%" -UserDataDir "C:\ChromeDebugProfile" -Force %*
endlocal
