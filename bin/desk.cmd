@echo off
rem Windows twin of bin/desk.
node --disable-warning=ExperimentalWarning "%~dp0..\src\cli.ts" %*
