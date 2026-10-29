-- Duo.app launcher (stay-open applet). Built by scripts/make-mac-app.sh.
-- Starts the Duo server if it is not already running, opens it in a chromeless window so it
-- feels like a normal app, and stops everything again when you quit (Cmd+Q or Dock > Quit).

property duoDir : "__DUO_DIR__"
property duoPort : "4317"
property serverPid : ""
property startedByUs : false
property usingAppWindow : false
property windowSeen : false

on run
	set serverPid to ""
	set startedByUs to false
	set usingAppWindow to false
	set windowSeen to false
	
	if not my isUp() then
		try
			set cmd to "cd " & quoted form of duoDir & " && PORT=" & duoPort & " exec node server.js"
			set serverPid to do shell script "mkdir -p \"$HOME/Library/Logs\"; (/bin/zsh -lic " & quoted form of cmd & " >> \"$HOME/Library/Logs/Duo.log\" 2>&1 & echo $!)"
			set startedByUs to true
		on error errMsg
			display alert "Duo could not start" message errMsg as critical
			quit
			return
		end try
		repeat 60 times
			if my isUp() then exit repeat
			delay 0.5
		end repeat
		if not my isUp() then
			display alert "Duo did not start" message "Look at ~/Library/Logs/Duo.log for details. Make sure Node 20 or newer is installed (brew install node)." as critical
			my cleanup()
			quit
			return
		end if
	end if
	my openWindow()
end run

on reopen
	my openWindow()
end reopen

on idle
	-- If the Duo window was closed, quit so the server does not keep running in the background.
	if usingAppWindow then
		if my windowRunning() then
			set windowSeen to true
		else if windowSeen then
			quit
		end if
	end if
	return 3
end idle

on quit
	my cleanup()
	continue quit
end quit

on cleanup()
	try
		do shell script "pkill -f " & quoted form of ("--user-data-dir=" & my profileDir())
	end try
	if startedByUs and serverPid is not "" then
		try
			do shell script "kill " & serverPid
		end try
	end if
end cleanup

on profileDir()
	return (POSIX path of (path to application support folder from user domain)) & "Duo/browser"
end profileDir

on windowRunning()
	try
		do shell script "pgrep -f " & quoted form of ("--user-data-dir=" & my profileDir())
		return true
	on error
		return false
	end try
end windowRunning

on isUp()
	try
		do shell script "curl -s -o /dev/null --max-time 1 http://127.0.0.1:" & duoPort & "/api/status"
		return true
	on error
		return false
	end try
end isUp

on openWindow()
	set theUrl to "http://localhost:" & duoPort
	set homePath to POSIX path of (path to home folder)
	-- A Chromium browser can show a page as a chromeless app window; Safari cannot.
	set candidates to {"Google Chrome", "Brave Browser", "Microsoft Edge", "Chromium", "Vivaldi"}
	repeat with b in candidates
		set appName to b as text
		try
			do shell script "test -d " & quoted form of ("/Applications/" & appName & ".app") & " -o -d " & quoted form of (homePath & "Applications/" & appName & ".app")
			do shell script "mkdir -p " & quoted form of my profileDir()
			do shell script "open -na " & quoted form of appName & " --args --app=" & theUrl & " --user-data-dir=" & quoted form of my profileDir() & " --no-first-run --no-default-browser-check --window-size=1480,940"
			set usingAppWindow to true
			return
		end try
	end repeat
	-- No Chromium browser installed: open in the default browser instead.
	set usingAppWindow to false
	do shell script "open " & theUrl
end openWindow
