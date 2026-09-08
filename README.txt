SILENCE UPGRADE - 3 steps
------------------------------------------------
1. Close Silence completely (also end "electron.exe" in Task Manager).
2. Double-click  INSTALL.bat
   It copies every file into C:\Users\rshre\Desktop\silence,
   runs "npm install" and starts the browser for you.
3. Look for these in the window that opens:
      - a lightning (⚡) button in the toolbar next to the puzzle icon
      - a pill saying "Silence Plus v1.1 is active"
      - Settings sidebar shows "Search settings" + 8 new sections
   and this line in the terminal, with NO crash after it:
      [core] built-in filter list active (22 patterns)

If your Silence folder is not C:\Users\rshre\Desktop\silence,
open INSTALL.bat in Notepad and change the DST line.

Troubleshooting: run "node check-silence.js" in the Silence folder
and send me the whole output.
