# Device bridge

The device bridge is the program that lets an agent connected to Jeeta drive a physical Android
phone (spec `docs/superpowers/specs/2026-10-28-device-bridge-design.md`). `jeeta-device-bridge`
runs on the Windows PC the phone is plugged into by USB, reaches the phone through `adb`, and
talks to Jeeta as an HTTPS **client**: Jeeta never connects to the PC or to the phone. It
registers the phones it sees, long-polls for their commands, runs each on its phone and posts
what it did. Agents reach the phones through the `jeeta.devices.*` tools (`list`, `observe`,
`act`, `command_get`, `commands`). In the panel, everyone who can see the capabilities sees the
phones' cards; only a person holding `devices.work` also sees each phone's commands.

There are no access restrictions in this phase (owner, spec §1): no app allowlist, no rate cap,
no approval per command, and `shell` runs whatever argument list it is given. Every command is
logged: the ledger's `devices.command.queued` entry carries the whole command, typed text and
shell arguments included, and `devices.command.finished` how it ended.

This page covers the phone's setup, the bridge's key and configuration file, running the bridge
(at logon too), how its heartbeat shows in the panel, what to do when something fails, and where
it was verified. The program's code is `rust/bridge/device/`.

## 1. The phone

Once per phone.

### Developer options and USB debugging

1. **Settings → About phone** (Telefon hakkında): tap **Build number** seven times, until the
   phone says you are a developer. On Xiaomi / MIUI phones the line to tap is **MIUI version**
   (MIUI sürümü).
2. **Developer options** (Geliştirici seçenekleri): on most phones under **Settings → System**,
   on Xiaomi / MIUI phones under **Settings → Additional settings** (Ek ayarlar). Turn on
   **USB debugging** (USB hata ayıklama).
3. On Xiaomi / MIUI phones also turn on, in the same list:
   - **USB debugging (Security settings)** (USB hata ayıklama (Güvenlik ayarları)). Without it
     the phone refuses every tap, swipe, key and typed text with a `SecurityException` naming
     `INJECT_EVENTS`, while `adb` itself reports success. The bridge reads that refusal in the
     output and fails the command with `adb_error` and the detail *the phone refused to inject
     input (SecurityException, INJECT_EVENTS); on a Xiaomi phone, turn on "USB debugging
     (Security settings)" in Developer options*. MIUI may ask you to sign in to a Mi account
     before it lets you turn it on.
   - **Install via USB**, if you will install ADBKeyBoard with `adb install` (below). Here too
     MIUI may ask for a Mi account first.
4. Keep the phone unlocked, with its screen on, while agents use it: the bridge does not unlock
   it (section 7).

Menu names vary with the phone and its version: HyperOS shows **OS version** where MIUI shows
**MIUI version**, and on Android 13 and later the keyboards are under **Settings → System →
Keyboard** (or **Languages & input**).

### The computer's adb and the RSA prompt

1. Install **adb**: Google's *Android SDK Platform-Tools* for Windows, unpacked into a folder
   such as `C:\platform-tools`. The bridge finds `adb.exe` on `PATH`, else in the Android SDK at
   `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`; or name it with the `adb` setting
   (section 3).
2. Plug the phone in by USB. The phone asks **Allow USB debugging?** and shows the computer's
   RSA key fingerprint: tick **Always allow from this computer** and allow. The key the phone
   now trusts is the Windows user's (`%USERPROFILE%\.android\adbkey`): run the bridge as that
   same user, or the phone asks again.
3. Check, in a Command Prompt or PowerShell:

   ```powershell
   adb devices -l
   ```

   A ready phone reads `device`, with its serial first, e.g.
   `R58M00000XX            device product:… model:… device:… transport_id:1`. The bridge lists
   only the phones `adb` calls `device`: one that reads `unauthorized` waits for the prompt on
   its screen, one that reads `offline` is attached but not reachable (section 7).

In Git Bash, `adb` arguments that begin with `/` (`/sdcard/…`, `/data/local/tmp/…`) are rewritten
into Windows paths before `adb` sees them. Prefix manual `adb` commands there with
`MSYS_NO_PATHCONV=1`, e.g. `MSYS_NO_PATHCONV=1 adb shell ls /sdcard/Download`, or use Command
Prompt or PowerShell. The bridge itself is not affected: it starts `adb` with an argument list,
through no shell.

### ADBKeyBoard, for text outside ASCII

`adb shell input text` types ASCII only: Turkish letters (`ç ğ ı ö ş ü`) and emoji come out
wrong. The bridge types such text through **ADBKeyBoard** (`com.android.adbkeyboard`), an input
method that types the text it is sent. Without it, ASCII text still works and other text is
refused (section 7).

1. Get the APK from its GitHub page, `github.com/senzhk/ADBKeyBoard` (its releases, or
   `ADBKeyboard.apk` in the repository).
2. Install it:

   ```powershell
   adb install ADBKeyboard.apk   # the APK you downloaded
   ```

   On Xiaomi / MIUI phones this fails with `INSTALL_FAILED_USER_RESTRICTED` while **Install via
   USB** is off. Either turn that on, or copy the APK to the phone and install it from there:

   ```powershell
   adb push ADBKeyboard.apk /sdcard/Download/
   ```

   then open the phone's **Files** app, go to **Download** and tap the APK. On MIUI the security
   scan screen shown after the install carries a large install button that is an advertisement
   for another app: do not tap it; close the screen.
3. **Enable** it as an input method: in the phone's keyboard settings (**Settings → System →
   Languages & input → On-screen keyboard → Manage keyboards**; on Xiaomi / MIUI phones under
   **Settings → Additional settings → Languages & input → Manage keyboards**) turn on
   **ADB Keyboard**. Or from the computer:

   ```powershell
   adb shell ime enable com.android.adbkeyboard/.AdbIME
   ```

   Installing it is not enough: the bridge checks, at each registration, that the package is
   installed (`pm list packages com.android.adbkeyboard`) **and** that `ime list -s` lists
   `com.android.adbkeyboard/.AdbIME`, and only then lists the phone's `text.unicode` feature.
   It does not need to be the default keyboard: for each text outside ASCII the bridge selects
   it (`ime set com.android.adbkeyboard/.AdbIME`), waits until it holds the focused field (at
   most 5 seconds), sends the text, and sets the phone's own keyboard back. A command cut off
   midway (the bridge stopped, or the command ran out of time) is undone when the bridge next
   recovers the phone: it puts back the keyboard it recorded, or, after a crash, the one the
   phone used before ADBKeyBoard.
4. Check: `adb shell ime list -s` lists `com.android.adbkeyboard/.AdbIME`. Within about 15
   seconds (the bridge's next registration, and the Devices tab's next refresh) the phone's card
   in the panel reads **Unicode metin: Evet** (section 6).

## 2. The bridge's API key

The bridge calls Jeeta with an API key issued with the single scope `devices.bridge`:

- In the panel: **Kabiliyetler → Cihazlar → Köprü eşleştir** issues it, shows it once, with the
  three install steps and a configuration file ready to copy (this server's address and the
  key). Or **API anahtarları**, a new key with the one scope **Cihaz köprüsü olarak çalışma
  (yalnızca köprünün anahtarı)** (`devices.bridge`); or `jeeta.api_keys.create` with
  `{"name": "Workshop PC", "scopes": ["devices.bridge"]}`. Never issue it with no scopes: a key
  issued without scopes holds every permission of its issuer, which the bridge routes refuse.
- Only someone holding `api_keys.manage` and `devices.bridge` can issue it: a key's scopes must
  be among its issuer's own. The owner and the manager hold both.
- A key holding any other permission is refused by every bridge route (`403`,
  `details.reason = "bridge_key_only"`), and a key holding only `devices.bridge` reaches nothing
  else. A panel session cookie is never accepted on these routes.
- **Each PC's bridge needs a key of its own.** The key is how Jeeta tells bridges apart: a poll
  carries nothing else. A phone is one bridge's at a time; another bridge that lists it while
  its holder still lists it and registered it in the last minute is refused it
  (`phone_held_by_another_bridge`, in the bridge's log). Two PCs can see a phone of the same
  serial (every emulator is `emulator-5554`).
- The plaintext is shown once. Keep it in the bridge's configuration file or in the
  `JEETA_DEVICE_BRIDGE_KEY` environment variable (section 3), never in Git, a chat or a
  screenshot. Revoking the key in the panel cuts the bridge off at its next call: it goes on
  trying, and is refused.
- **Replacing a key:** start the bridge with the new key, stop the old program cleanly (Ctrl+C:
  it posts what it finished, with the old key), then revoke the old key. The new bridge is
  refused each phone the old one held until the old one has not registered it for a minute;
  then it takes the phone over (`devices.phone.holder_changed` in the ledger).

The bridge acts as the system component `device_bridge`, not as an agent connection.

## 3. The configuration file

The bridge reads a TOML file: `jeeta-device-bridge.toml` next to the program, or the file named
by its first argument:

```toml
base_url = "https://jeeta.example"   # this Jeeta's public address: the panel's own
key = "jt_…"                         # the devices.bridge key; or JEETA_DEVICE_BRIDGE_KEY
adb = 'C:\platform-tools\adb.exe'    # optional
serials = ["R58M00000XX"]            # optional: only these phones
bridge_id = "WORKSHOP-PC"            # optional: this computer's name in Jeeta
```

| Setting | |
|---|---|
| `base_url` | Required. `https`, or plain `http` only to this computer (`localhost`, `127.0.0.1`, `[::1]`); no user name, password, query or fragment. The routes are joined under it: `api/devices/bridge/…`. |
| `key` | The `devices.bridge` key, as a quoted string. The environment variable `JEETA_DEVICE_BRIDGE_KEY` wins over it when set, so the file can be kept without the key. |
| `adb` | The `adb` program. Default: `adb.exe` on `PATH`, else `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`, else plain `adb`. Use single quotes for a Windows path (no escapes). |
| `serials` | Only these phones are reported; leave it out to report every ready phone (at most 16). An empty list is refused. |
| `bridge_id` | This bridge's name, shown on each phone's card as **Bilgisayar**. Default: the computer's name (`COMPUTERNAME`); at most 128 characters. |

An unknown setting is refused, so a misspelt one does not pass unnoticed. A file that cannot be
used stops the bridge at once with exit status 2 and a line that names the setting
(`the configuration cannot be used`, e.g. `key: is not set: give it in the file or in
JEETA_DEVICE_BRIDGE_KEY`); no error ever repeats the key.

## 4. Running the bridge

The program is `jeeta-device-bridge.exe`: the `device-bridge-windows` job of the Rust CI
workflow uploads it as the artifact `jeeta-device-bridge-windows-<commit>`, or build it in
`rust/` with `cargo build --release -p jeeta-device-bridge`
(`rust/target/release/jeeta-device-bridge.exe`). Put it in a folder of its own, say
`C:\Jeeta\`, with `jeeta-device-bridge.toml` beside it, and run it:

```powershell
C:\Jeeta\jeeta-device-bridge.exe
C:\Jeeta\jeeta-device-bridge.exe D:\elsewhere\bridge.toml   # another configuration file
```

It logs to its console. `JEETA_DEVICE_BRIDGE_LOG` sets the filter (default `info`; `debug` for
more). It starts with `jeeta-device-bridge starting` (its version, `bridge_id`, the server and
the `adb` it uses), then logs `registered phones` with their serials whenever that set changes.
The log never carries the key, a command's arguments, what a phone shows or prints, a file, or a
signed address.

What it does:

- **Registers** every 15 seconds (the server's `heartbeat_s`) with the phones `adb devices -l`
  lists ready, each with its model, Android version, screen size and features (every command
  kind, and `text.unicode` when ADBKeyBoard is installed and enabled). A phone whose report fails
  stands in by its last good one for up to three registrations, so a slow `adb` does not take it
  offline.
- **Polls** for commands (a long-poll of up to 25 seconds) and runs each phone's commands one
  after the other, in the order they came; different phones at the same time. A command runs at
  most 120 seconds (a `push_file` or `pull_file` 30 minutes), else it is cut off and fails
  `timeout`. One that waited more than five minutes before it could run is failed `timeout`
  without running.
- **Observes** with `uiautomator dump`, written to `/data/local/tmp/jeeta_ui.xml` on the phone
  and removed once read, and reads the screen's size (`wm size`) and rotation on every
  observation, so a phone that auto-rotates is reported as it stands.
- **Uploads** what a command produced: a screenshot (PNG; Jeeta stores up to 25 MB of image) or a
  pulled file (up to 95 MiB: Jeeta's servers sit behind Cloudflare, which refuses a request body
  over 100 MB; `pull_file` checks the size on the phone before copying). Jeeta keeps these files
  7 days, then the `device_file_purge` job deletes them; the address an agent gets for one
  (`file_url`) works for 10 minutes.

Stop it with **Ctrl+C** (or **Ctrl+Break**) in its console: within 5 seconds polling stops, a
running command is failed `bridge_error` and its phone recovered, commands still queued are
handed out again to the next bridge that polls for their phone within their 5 minutes, and the
results made are posted. Closing its console window, logging off or shutting down are meant to
stop it within 2 seconds, but closing the console window currently cuts it off at once
(section 7). It exits with status 0 when stopped, 2 when its configuration cannot be used, and a
failure status when one of its tasks ended on its own.

## 5. Running it at logon

Windows **Task Scheduler** starts the bridge each time you log on, in your session (so `adb`
uses your RSA key) with its console window visible.

With the PowerShell module, in a PowerShell window run as administrator with your own account
(change `C:\Jeeta` to the program's folder):

```powershell
$action    = New-ScheduledTaskAction -Execute 'C:\Jeeta\jeeta-device-bridge.exe' -WorkingDirectory 'C:\Jeeta'
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 `
               -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Jeeta device bridge' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName 'Jeeta device bridge'   # start it now, without logging off
```

`-ExecutionTimeLimit ([TimeSpan]::Zero)` matters: a scheduled task is otherwise stopped after 3
days. Remove the task with `Unregister-ScheduledTask -TaskName 'Jeeta device bridge'`.

Or in the Task Scheduler window: **Create Task…**

1. **General**: name `Jeeta device bridge`; **Run only when user is logged on**, as your own
   account.
2. **Triggers → New…**: **Begin the task: At log on**, **Specific user**: your account.
3. **Actions → New…**: **Start a program**, `C:\Jeeta\jeeta-device-bridge.exe`, **Start in**:
   `C:\Jeeta`.
4. **Conditions**: untick **Start the task only if the computer is on AC power**.
5. **Settings**: untick **Stop the task if it runs longer than**; tick **If the task fails,
   restart every: 1 minute**, attempts 3.

Stop it with Ctrl+C in its console window (closing the window cuts it off, section 7); it starts
again at the next logon, or with **Run** in Task Scheduler.

## 6. Heartbeat and the panel

- The first registration that lists a phone declares its `phone` capability, named after its
  model and serial (`Galaxy A52 (R58M00000XX)`), with `android:<serial>` as its external id, and
  verifies it. Each registration verifies it again and merges what it reported into
  `connector_public.device`, key by key: a fact one registration could not read is kept.
- A phone takes commands while it reads **verified** (a registration that lists it at most 60
  seconds ago) and its bridge's latest registration lists it. Unplugged, or no longer `device` in
  `adb`, it is left out of the bridge's next registration (within 15 seconds) and takes no
  command from then on (`device_offline`); it reads **stale** a minute after the last
  registration that listed it.
- The `device_bridge_health` job (every minute) marks it **unreachable** once no registration
  listed it for 10 minutes, and writes `devices.bridge.offline` to the ledger; the next
  registration that lists it verifies it again and writes `devices.bridge.online`.
- While a phone is declared, stale or unreachable, `jeeta.work.pending` lists `phone_offline`
  for the agent, and the panel's home page shows it.
- It cannot be verified by evidence: only its bridge's registrations verify it. A phone no longer
  used is retired (`jeeta.capability.retire`, or **Emekliye ayır** on its card); a retired phone
  that is still plugged in is refused at registration (`phone_retired`) and not listed again
  until the bridge restarts.
- Its card on the **Kabiliyetler** page shows its status and how long ago its bridge last
  listed it, the platform, model, Android version, the computer, the bridge's version, whether it
  types Unicode text (with the ADBKeyBoard hint when not), and the commands it runs; everyone who
  can see the capabilities sees it. To someone holding `devices.work` it also shows the phone's
  last 20 commands (kind, status, time), each opening to its arguments and its result, followed
  until the command ends; a file a result names opens at an address signed on the click. The
  **Cihazlar** filter reads the phones and their logs again every 15 seconds while it is shown.
  Commands are never deleted; the ledger keeps every one.

## 7. Troubleshooting

**`unauthorized`** (`adb devices -l`; the bridge logs *a phone waits for its USB debugging
prompt to be accepted on its screen*). Unlock the phone and accept the **Allow USB debugging?**
prompt, ticking **Always allow from this computer**. No prompt: unplug and plug in again; or in
**Developer options** tap **Revoke USB debugging authorizations**, then plug in again; or run
`adb kill-server` and `adb devices`. A bridge run as another Windows user (a scheduled task under
another account) has another RSA key, which the phone has not allowed.

**`offline`** (`adb devices -l`; the bridge logs *a phone is attached but not ready* with
`state=offline`; a command fails `device_offline`, *adb cannot reach the phone: device offline*).
Unplug and plug in again, try another cable or USB port, or run `adb kill-server` then
`adb devices`.

**Taps and typing fail with `INJECT_EVENTS`** (Xiaomi / MIUI phones; `adb_error`, *the phone
refused to inject input (SecurityException, INJECT_EVENTS); …*). Turn on **USB debugging
(Security settings)** (section 1).

**Screen busy** (`screen_busy`, *the screen kept moving (uiautomator: could not get idle state),
also when tried again; try again once it is still*). `uiautomator dump` refuses a screen that is
still moving (an animation, a video, a page loading); the bridge tries again once after 700 ms.
Ask again once the screen is still, or press `home` / `back` to leave a screen that never stops.
*uiautomator wrote no screen; try again* fails with the same `screen_busy` reason, but means the
dump held no element at all, not necessarily that the screen moved: try again.

**An observation lists no elements** (seen on the Redmi 10C) while the screen is asleep, the lock
screen behind it; with the screen on, a locked phone's observation lists the lock screen's
elements. Wake the phone (`key` `power`) and unlock it. Also seen there: after the power key,
MIUI's `ScreenOnProximitySensorGuide` window appeared and the screen went back off while the phone
lay face down or covered, so keep it face up and uncovered. A later bridge version is meant to
report the screen's state, so that an empty observation says why.

**Unicode refused.** Before anything is queued, `devices.act` refuses a `text` with characters
outside ASCII for a phone whose bridge does not list `text.unicode` (`422 VALIDATION`,
`details.reason = "unicode_unsupported"`, with a hint: install ADBKeyBoard and enable it as an
input method). On the phone, a `text` fails `unicode_unsupported` with *ADBKeyBoard is installed
but not enabled as an input method in the phone's keyboard settings*, or with *install
ADBKeyBoard (com.android.adbkeyboard) and enable it as an input method*. Install and enable it
(section 1); the next registration, within 15 seconds, lists `text.unicode`. A `text` that fails
`adb_error` with *ADBKeyBoard did not take the focused field within 5000 ms; tap a text field
first* found no focused text field: tap one, then type.

**`uiautomator dump` prints a stack trace** (Xiaomi / MIUI phones: a
`FileNotFoundException … theme_compatibility.xml`). Harmless: MIUI's tools print it and dump all
the same, and the bridge judges a dump by the file it wrote.

**A phone is refused at registration.** *the server refused a phone* with its serial and
`phone_held_by_another_bridge`: another PC's bridge holds it (section 2); it is free a minute
after that bridge stops listing it. *the server refused a retired phone; it is not listed again
until the bridge restarts*: it was retired in Jeeta, and the bridge leaves it out until it
restarts.

**The bridge cannot register** (*registering with Jeeta failed*, tried again after a growing
pause). `the server answered 401`: the key is wrong or revoked, or whoever issued it is no longer
a member of the workspace. `403`: the key holds more than `devices.bridge` (`bridge_key_only`), or
its issuer no longer holds `devices.bridge` (a key acts with the scopes its issuer still holds).
`423`: the workspace is not active. A connection error: check `base_url` and the network.

**Closing the console window** cuts the bridge off at once instead of letting it finish (seen on
Windows 11): the command it was running is not answered. Jeeta hands an unanswered command out
again 10 seconds after it was handed out, but only to a bridge that polls for that phone (this
one once it runs again, or another bridge that holds the phone by then) and only within the
command's 5 minutes; that bridge cannot know the command already ran, and may run it a second
time (type the text twice, say). If no bridge polls in time, the command ends `expired`. Stop
the bridge with Ctrl+C instead.

## 8. Verified on

- Xiaomi Redmi 10C, Android 13, MIUI 14, on Windows 11, 2026-10-29: `devices.list`, `observe`,
  `shell`, `key`, `launch_app`, `tap_on`, ASCII and Turkish `text` (through ADBKeyBoard, the
  phone's own keyboard set back after it), `screenshot`, `pull_file`; the ledger carries each
  command with its full arguments; Ctrl+C stops the bridge cleanly.
