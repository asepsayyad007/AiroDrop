@echo off
:: install-autostart.bat
:: Run this script once to make the AirDrop-to-PC server start automatically when Windows boots.
:: This creates a scheduled task that launches the server silently on user logon.

set TASK_NAME="AirDropToPC"
set TASK_DESC="iPhone to PC image and text sender - starts on login"

:: Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"

:: Create a VBS wrapper that launches the server hidden (no console window)
echo Set WshShell = CreateObject("WScript.Shell") > "%SCRIPT_DIR%start-hidden.vbs"
echo WshShell.CurrentDirectory = "%SCRIPT_DIR%" >> "%SCRIPT_DIR%start-hidden.vbs"
echo WshShell.Run "cmd /c node server.js > server.log 2>&1", 0, False >> "%SCRIPT_DIR%start-hidden.vbs"

:: Remove existing task if it exists (ignore errors)
schtasks /delete /tn %TASK_NAME% /f >nul 2>&1

:: Create scheduled task: runs at user logon, with highest privileges
schtasks /create /tn %TASK_NAME% /tr "wscript.exe \"%SCRIPT_DIR%start-hidden.vbs\"" /sc onlogon /rl highest /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo  [SUCCESS] Auto-start configured!
    echo  The server will start automatically when you log into Windows.
    echo.
    echo  To remove auto-start later, run:  uninstall-autostart.bat
    echo.
) else (
    echo.
    echo  [ERROR] Failed to create scheduled task.
    echo  Try running this script as Administrator.
    echo.
)

pause