@echo off
REM scripts/sync_diario.bat — Lanzador de Windows para el sync diario.
REM
REM Ya NO contiene la logica: solo llama a scripts/sync_diario.py, que es
REM multiplataforma y corre igual en el cron de Railway. Se conserva este
REM .bat para no tener que reconfigurar la tarea programada existente
REM ("AgentKit_Ambar_SyncDiario", diaria a las 7:00am).
REM
REM El codigo de salida del .py se propaga, asi que el Task Scheduler ahora
REM SI puede distinguir una corrida exitosa de una fallida (antes siempre
REM reportaba 0 aunque el catalogo hubiera reventado).

cd /d "%~dp0\.."
C:\Python313\python.exe scripts\sync_diario.py
exit /b %ERRORLEVEL%
