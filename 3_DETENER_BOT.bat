@echo off
title Detener CRM AI Bot
chcp 65001 >nul

echo Deteniendo instancias de Node y túnel...
taskkill /F /IM node.exe >nul 2>nul
taskkill /F /IM cloudflared.exe >nul 2>nul

echo [OK] El bot y el servidor CRM se han detenido correctamente.
timeout /t 3 >nul
