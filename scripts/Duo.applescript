-- Duo.app launcher (stay-open applet). Built by scripts/make-mac-app.sh.
-- Starts the Duo server if it is not running (and restarts it if it dies), opens Duo in a
-- chromeless window so it feels like a normal app, and stops everything when you quit
-- (Cmd+Q or Dock > Quit) or close the window.

property duoDir : "__DUO_DIR__"
property duoPort : "4317"
property serverPid : ""
property startedByUs : false
property usingAppWindow : false
property windowSeen : false

on run
	set startedByUs to false
	set serverPid to ""
	set usingAppWindow to false
	set windowSeen to false
	if my ensureServer(true) then
		my openWindow()
	else
		quit
	end if
end run

-- Clicking the Dock icon again: make sure the server is alive, then show the window.
on reopen
	if my ensureServer(true) then my openWindow()
end reopen

on idle
	if usingAppWindow then
		if my windowRunning() then
			set windowSeen to true
			-- The server died (killed, crashed): bring it back instead of leaving a dead page.
			if not my isUp() then my ensureServer(false)
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

-- Makes sure a current Duo server answers on the port. Replaces a stale one, starts one if none.
-- loud = show an alert on failure.
on ensureServer(loud)
	if my isUp() and my isStale() then my killOldServer()
	if my isUp() then return true
	
	if not my preflight(loud) then return false
	try
		set cmd to "cd " & quoted form of duoDir & " && PORT=" & duoPort & " exec node server.js"
		set serverPid to do shell script "mkdir -p \"$HOME/Library/Logs\"; (/bin/zsh -lic " & quoted form of cmd & " >> \"$HOME/Library/Logs/Duo.log\" 2>&1 & echo $!)"
		set startedByUs to true
	on error errMsg
		if loud then display alert "Duo could not start" message errMsg as critical
		return false
	end try
	repeat 60 times
		if my isUp() then return true
		delay 0.5
	end repeat
	if loud then
		set tailText to ""
		try
			set tailText to do shell script "tail -n 12 \"$HOME/Library/Logs/Duo.log\" 2>/dev/null | cut -c1-160"
		end try
		display alert "Duo did not start" message "The server did not answer in 30 seconds. Last lines of ~/Library/Logs/Duo.log:" & return & return & tailText as critical
	end if
	return false
end ensureServer

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

-- Checks the folder, Node and its version in the same kind of shell the server will run in,
-- so a failure says exactly what is wrong instead of just "did not start".
on preflight(loud)
	set checkCmd to "cd " & quoted form of duoDir & " || exit 11; command -v node >/dev/null || exit 12; node -e 'process.exit(+process.versions.node.split(\".\")[0]>=20?0:1)' || exit 13"
	try
		do shell script "/bin/zsh -lic " & quoted form of checkCmd
		return true
	on error errMsg number n
		if loud then
			if n is 11 then
				display alert "Duo cannot open its folder" message "macOS is blocking access to " & duoDir & ". If it is in Documents, Desktop or Downloads, allow Duo under System Settings > Privacy & Security > Files and Folders (or Full Disk Access), then open Duo again." as critical
			else if n is 12 then
				display alert "Node is not installed" message "Duo needs Node 20 or newer, and your Terminal setup could not find it. Run this in Terminal, then open Duo again:" & return & return & "brew install node" as critical
			else if n is 13 then
				display alert "Node is too old" message "Duo needs Node 20 or newer. Run this in Terminal, then open Duo again:" & return & return & "brew upgrade node" as critical
			else
				display alert "Duo could not start" message errMsg as critical
			end if
		end if
		return false
	end try
end preflight

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

on pingText()
	try
		return do shell script "curl -sf --max-time 2 http://127.0.0.1:" & duoPort & "/api/ping"
	on error
		return ""
	end try
end pingText

on isStale()
	set t to my pingText()
	-- Servers from before this check existed answer without a "stale" field: treat those as stale too.
	return (t does not contain "\"stale\":false")
end isStale

on killOldServer()
	try
		set oldPid to do shell script "curl -sf --max-time 2 http://127.0.0.1:" & duoPort & "/api/ping | sed -n 's/.*\"pid\":\\([0-9][0-9]*\\).*/\\1/p'"
		if oldPid is "" then set oldPid to do shell script "lsof -ti tcp:" & duoPort & " -sTCP:LISTEN | head -n 1"
		if oldPid is not "" then do shell script "kill " & oldPid
	end try
	repeat 20 times
		if not my isUp() then exit repeat
		delay 0.25
	end repeat
end killOldServer

on isUp()
	try
		do shell script "curl -sf -o /dev/null --max-time 2 http://127.0.0.1:" & duoPort & "/api/ping"
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
