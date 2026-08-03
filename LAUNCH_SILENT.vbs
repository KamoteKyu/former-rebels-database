Set oShell = CreateObject("WScript.Shell")
oShell.Run """" & Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")) & "LAUNCH_APP.bat""", 0, False
