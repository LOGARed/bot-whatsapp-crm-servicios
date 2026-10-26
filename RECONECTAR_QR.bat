@echo off
title Reconectar WhatsApp QR
chcp 65001 >nul
cd /d "%~dp0"

echo =====================================================================
echo                RECONECTAR SESION DE WHATSAPP
echo =====================================================================
echo.
echo Esta accion borrara la sesion guardada y generara un nuevo QR.
echo.
set /p confirm="Desea continuar? (S/N): "
if /i not "%confirm%"=="S" goto fin

rem Detener bot si esta corriendo
taskkill /F /IM node.exe >nul 2>nul
taskkill /F /IM cloudflared.exe >nul 2>nul

echo Limpiando sesion anterior...
if exist "auth_session" rmdir /s /q "auth_session"

echo Iniciando para generar nuevo codigo QR...
node index.js

:fin
