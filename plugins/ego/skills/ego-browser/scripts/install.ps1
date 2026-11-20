#v1.0 2026.11.16 22:54
#
# Installs ego lite only when it is missing, then starts onboarding.
# An existing installation is left unchanged and its ego-browser path is
# printed. The script takes no arguments; run ego-browser for commands.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# It also runs through Invoke-Expression, as in irm <url> | iex. Typed into
# an open window, it leaves the window open and puts the exit code in
# $LASTEXITCODE. Normal completion leaves $? True; version and language-mode
# precondition failures throw. A one-shot powershell -Command, or a powershell
# that reads commands from a pipe, exits with the code.
#
# Installing usually raises a User Account Control prompt that the user has
# to answer. Started from a background process, such as an agent's shell,
# the prompt can open behind other windows or only flash on the taskbar, so
# tell the user to look for it; the script reminds them while it waits.
#
# Diagnostics go to the process's stderr, not to PowerShell's error stream:
# inside a PowerShell session, 2> does not capture them, so run a separate
# powershell to log them. stdout carries only ego-browser's own output.
# Exit codes: 0 when ego lite was already installed, otherwise the exit code
# of ego-browser onboarding after a successful install. Script errors exit
# with 1. A failing installer's code is passed on unless its low 8 bits are
# 0, which Git Bash would report as success, in which case the script exits
# with 1. The full code is always in the "error:" line on stderr.
#
# Keep this file ASCII-only for Windows PowerShell 5.1 without a BOM.

# Everything runs in a script block. Through Invoke-Expression this script
# shares the caller's scope, and in a window that stays open its functions,
# variables and preferences must not outlive it.
& {
  $SetupUrlX64 = 'https://cdn.ego.app/setup/windows/x64/egoliteSetup.exe'
  # Arm64 currently uses the x64 installer.
  $SetupUrlArm64 = $SetupUrlX64
  $DownloadPageUrl = 'https://lite.ego.app/'
  # The O= field of the code signing certificate's subject.
  $SignerPattern = '(?:^|,\s*)O="?CITRO LABS PTE\. LIMITED"?(?:,|$)'
  $AppGuid = '{712B23BF-E734-4038-BE42-D5736B6D9570}'
  $ProductPath = 'Citro Labs\ego lite\Application'
  $BrowserExeName = 'ego.exe'
  $CliExeName = 'ego-browser.exe'
  # The updater exits with this code when another installation holds its
  # setup lock.
  $SetupLockedExitCode = 75075
  # The updater could not register itself with its service.
  $SetupRegistrationFailedExitCode = 75003
  $MinimumWindowsMajorVersion = 10
  $ExitCodeKey = 'install.ps1 exit code'

  if ($PSVersionTable.PSVersion -lt [version]'5.1') {
    $global:LASTEXITCODE = 1
    throw ('install.ps1 requires PowerShell 5.1 or later. Update PowerShell ' +
           'or download the official installer from ' + $DownloadPageUrl)
  }

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $ScriptArgs = @($args)

  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    $global:LASTEXITCODE = 1
    throw ('install.ps1 needs the FullLanguage mode of PowerShell. Install ' +
           'ego lite from ' + $DownloadPageUrl + ' instead.')
  }

  # A redirected stderr is read by programs, which expect the UTF-8 that
  # ego-browser also writes; the console code page would garble non-ASCII
  # paths such as a Chinese user name.
  $StderrWriter = $null
  if ([Console]::IsErrorRedirected) {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $StderrWriter = New-Object System.IO.StreamWriter(
        [Console]::OpenStandardError(), $utf8)
    $StderrWriter.AutoFlush = $true
  }

  # Diagnostics always use process stderr, which the terminal shows by default.
  function Write-Log([string]$Message) {
    if ($StderrWriter) {
      $StderrWriter.WriteLine($Message)
    } else {
      [Console]::Error.WriteLine($Message)
    }
  }

  # exit would end a whole PowerShell session that runs this script through
  # Invoke-Expression, so unwind to the end of the script instead, which
  # decides how to finish.
  function Stop-Script([string]$Message, [int]$ExitCode = 1) {
    Write-Log ('error: ' + $Message)
    $unwind = New-Object System.Exception $Message
    $unwind.Data[$ExitCodeKey] = $ExitCode
    throw $unwind
  }

  function Get-RegistryValue([string]$Hive, [string]$View, [string]$SubKey,
                             [string]$Name) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive, $View)
    try {
      $key = $base.OpenSubKey($SubKey)
      if ($null -eq $key) {
        return $null
      }
      try {
        return $key.GetValue($Name)
      } finally {
        $key.Close()
      }
    } finally {
      $base.Close()
    }
  }

  function Get-FileVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      return $null
    }
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
    if (-not ($info.FileMajorPart -or $info.FileMinorPart -or
              $info.FileBuildPart -or $info.FilePrivatePart)) {
      return $null
    }
    return ('{0}.{1}.{2}.{3}' -f $info.FileMajorPart, $info.FileMinorPart,
            $info.FileBuildPart, $info.FilePrivatePart)
  }

  function Find-InstallDirectory {
    $levels = @(
      @{ Hive = 'LocalMachine'; View = 'Registry32';
         Roots = @($env:ProgramW6432,
                   [Environment]::GetFolderPath('ProgramFiles'),
                   [Environment]::GetFolderPath('ProgramFilesX86')) },
      @{ Hive = 'CurrentUser'; View = 'Default';
         Roots = @([Environment]::GetFolderPath('LocalApplicationData')) }
    )
    foreach ($level in $levels) {
      $uninstall = Get-RegistryValue $level.Hive $level.View `
          "SOFTWARE\Citro Labs\Update\ClientState\$AppGuid" 'UninstallString'
      $dirs = New-Object 'System.Collections.Generic.List[string]'
      # UninstallString is <Application>\<version>\Installer\setup.exe.
      if ($uninstall) {
        try {
          $setupPath = ([string]$uninstall).Trim().Trim('"')
          $dirs.Add([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName(
              [IO.Path]::GetDirectoryName($setupPath))))
        } catch {
        }
      }
      foreach ($root in $level.Roots) {
        if ($root) {
          $dirs.Add((Join-Path $root $ProductPath))
        }
      }
      foreach ($dir in $dirs) {
        if (-not $dir) {
          continue
        }
        # Join-Path fails on a missing drive, which a stale value can name.
        $browser = [IO.Path]::Combine($dir, $BrowserExeName)
        if (Test-Path -LiteralPath $browser -PathType Leaf) {
          return $dir
        }
      }
    }
    return $null
  }

  # ego-browser ships in the version directory of the installed browser.
  function Get-CliPath([string]$ApplicationDir) {
    $version = Get-FileVersion (Join-Path $ApplicationDir $BrowserExeName)
    if (-not $version) {
      return $null
    }
    $cli = Join-Path (Join-Path $ApplicationDir $version) $CliExeName
    if (Test-Path -LiteralPath $cli -PathType Leaf) {
      return $cli
    }
    return $null
  }

  function Write-CliUsage([string]$Cli, [bool]$ShowOnboardingNotice = $true) {
    if ($ShowOnboardingNotice) {
      Write-Log 'Complete onboarding before using ego-browser.'
    }
    Write-Log 'Use either option below:'
    Write-Log ('Current terminal: run ego-browser using the full path "{0}".' -f
               $Cli)
    Write-Log 'New terminal: run ego-browser.exe directly.'
  }

  function Start-Onboarding([string]$ApplicationDir, [bool]$Elevated) {
    $cli = Get-CliPath $ApplicationDir
    if (-not $cli) {
      Stop-Script ('ego lite was installed in "' + $ApplicationDir + '", but ' +
                   'its ego-browser was not found.')
    }

    Write-Log 'Starting ego lite onboarding ...'
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $cli
    $startInfo.Arguments = 'onboarding'
    $startInfo.UseShellExecute = $false
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
      $process.WaitForExit()
      $exitCode = $process.ExitCode
    } finally {
      $process.Dispose()
    }
    if ($exitCode -ne 0) {
      $where = ''
      if ($Elevated) {
        $where = ' from a terminal that is not elevated'
      }
      Write-Log (('error: ego lite was installed, but onboarding exited with ' +
                  'code {0}. Retry{1} using the command for your shell:') -f
                 $exitCode, $where)
      Write-Log ('cmd: "{0}" onboarding' -f $cli)
      Write-Log ('PowerShell: & "{0}" onboarding' -f $cli)
    }
    # Keep the prerequisite on failures; successful CLI calls already handle it.
    Write-CliUsage $cli ($exitCode -ne 0)
    return $exitCode
  }

  # Waits for the installer alone: a per-user install launches the browser,
  # which must not keep this script waiting. A User Account Control prompt
  # raised from a background process can open behind other windows or only
  # flash on the taskbar. Remind the user after the first minute, then every
  # minute while any prompt is pending. It may belong
  # to another program, so the reminder names the one to answer.
  function Wait-Installer([System.Diagnostics.Process]$Process) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $nextReminder = 60
    while (-not $Process.WaitForExit(1000)) {
      if ($clock.Elapsed.TotalSeconds -lt $nextReminder) {
        continue
      }
      if (@(Get-Process -Name consent -ErrorAction Ignore).Count) {
        Write-Log ('Still installing. If a Windows permission prompt (User ' +
                   'Account Control) for "ego Installer" from CITRO LABS ' +
                   'PTE. LIMITED is open, choose Yes to install.')
        Write-Log ('The prompt may open behind other windows or flash on ' +
                   'the taskbar.')
        Write-Log 'Installation may take a few minutes; do not interrupt it.'
      }
      # Count from now, not from the missed due time, so that a pause, such
      # as sleep or a selection that holds up the console, does not set off
      # a burst of reminders.
      $nextReminder = $clock.Elapsed.TotalSeconds + 60
    }
  }

  # ShellExecute keeps the installer from inheriting this console's handles,
  # so its own logging stays out of the stderr that ego-browser writes to.
  function Invoke-Installer([string]$Path) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Path
    $startInfo.Arguments = '--silent=allow-uac'
    $startInfo.UseShellExecute = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
      Write-Log 'Installing ego lite, please wait...'
      Wait-Installer $process
      return $process.ExitCode
    } finally {
      $process.Dispose()
    }
  }

  function Select-SetupUrl([string]$Architecture) {
    switch ($Architecture) {
      'AMD64' { return $SetupUrlX64 }
      'ARM64' { return $SetupUrlArm64 }
      default {
        Stop-Script ('unsupported Windows architecture: ' + $Architecture)
      }
    }
  }

  function Enable-Tls12 {
    $protocols = [Net.ServicePointManager]::SecurityProtocol
    # 0 is SystemDefault, which already lets Windows pick TLS 1.2 or later.
    if ([int]$protocols -ne 0 -and -not ([int]$protocols -band 3072)) {
      [Net.ServicePointManager]::SecurityProtocol =
          [Net.SecurityProtocolType]([int]$protocols -bor 3072)
    }
  }

  # WebException messages are localized on a worker thread whatever the
  # script's culture, so describe failures by status instead.
  function Get-DownloadError($ErrorRecord) {
    $exception = $ErrorRecord.Exception
    while ($exception -and -not ($exception -is [Net.WebException]) -and
           $exception.InnerException) {
      $exception = $exception.InnerException
    }
    if ($exception -is [Net.WebException]) {
      if ($exception.Response -and $exception.Response.StatusCode) {
        return ('HTTP {0} {1}' -f [int]$exception.Response.StatusCode,
                $exception.Response.StatusCode)
      }
      return ('network error {0}' -f $exception.Status)
    }
    return $ErrorRecord.Exception.Message
  }

  # Wait up to 30 seconds for a response, not for the complete file download.
  # Retry failed downloads up to three attempts.
  function Save-Installer([string]$Url, [string]$Destination) {
    Enable-Tls12
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        # Without a timeout, a connection that never answers hangs forever.
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing `
            -TimeoutSec 30
        return
      } catch {
        $message = Get-DownloadError $_
        if ($attempt -eq 3) {
          Stop-Script ('failed to download ego lite from {0}: {1}' -f
                       $Url, $message)
        }
        Write-Log ('Download failed ({0}); retrying ...' -f $message)
        Start-Sleep -Seconds 2
      }
    }
  }

  function Assert-InstallerSignature([string]$Path) {
    # A PowerShell 7 parent that starts this script through another process,
    # such as Git Bash, leaves its own module paths in PSModulePath, and
    # Windows PowerShell then cannot load Microsoft.PowerShell.Security from
    # them. Load the in-box module by its path instead.
    if ($PSVersionTable.PSEdition -ne 'Core') {
      $module = 'Microsoft.PowerShell.Security'
      Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', $module,
                                        $module + '.psd1'))
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = ''
    if ($signature.SignerCertificate) {
      $subject = $signature.SignerCertificate.Subject
    }
    if ($signature.Status -ne 'Valid' -or $subject -notmatch $SignerPattern) {
      # Limit untrusted certificate text before displaying it.
      $signer = $subject -replace '[^\x20-\x7E]', '?'
      if ($signer.Length -gt 100) {
        $signer = $signer.Substring(0, 100) + '...'
      }
      if ($signature.Status -ne 'Valid') {
        $reason = switch ([string]$signature.Status) {
          'NotSigned' { 'the downloaded file has no digital signature' }
          'HashMismatch' {
            'the file contents do not match its signature; the file may ' +
            'have been changed or damaged'
          }
          'NotTrusted' { 'Windows does not trust the signing certificate' }
          default { 'Windows could not verify the digital signature' }
        }
        Stop-Script (('installer signature verification failed: {0} ' +
                      '(status: {1}). Installation stopped. Download the ' +
                      'installer again from {2}') -f
                     $reason, $signature.Status, $DownloadPageUrl)
      }
      Stop-Script (('installer publisher mismatch. Expected organization: ' +
                    'CITRO LABS PTE. LIMITED. Actual certificate: {0}. ' +
                    'Installation stopped. Download the official installer ' +
                    'from {1}') -f $signer, $DownloadPageUrl)
    }
  }

  # The installer can hold its file for a moment after it exits. Failed
  # attempts are ignored rather than caught so that they leave no records in
  # $Error of a session that stays open.
  function Remove-TempDir([string]$Path) {
    for ($attempt = 1; $attempt -le 10; $attempt++) {
      Remove-Item -LiteralPath $Path -Recurse -Force -Confirm:$false `
          -ErrorAction Ignore
      if (-not (Test-Path -LiteralPath $Path)) {
        return
      }
      Start-Sleep -Seconds 1
    }
    Write-Log ('warning: could not remove ' + $Path)
  }

  function Install-EgoLite([bool]$Elevated) {
    if ($Elevated) {
      Write-Log ('Running as administrator, so ego lite will be installed ' +
                 'for all users. install.ps1 does not need administrator ' +
                 'rights.')
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
      Stop-Script 'ego lite needs 64-bit Windows.'
    }
    $architecture = [Environment]::GetEnvironmentVariable(
        'PROCESSOR_ARCHITECTURE', 'Machine')
    $setupUrl = Select-SetupUrl $architecture
    $tempRoot = [IO.Path]::GetTempPath()
    # Clear what an interrupted earlier run left behind.
    foreach ($stale in @(Get-ChildItem -LiteralPath $tempRoot -Directory `
                             -Filter 'ego-lite-install-*' `
                             -ErrorAction Ignore)) {
      if ($stale.LastWriteTime -lt (Get-Date).AddDays(-1)) {
        Remove-Item -LiteralPath $stale.FullName -Recurse -Force `
            -Confirm:$false -ErrorAction Ignore
      }
    }
    $tempDir = Join-Path $tempRoot `
        ('ego-lite-install-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $tempDir
    try {
      $setup = Join-Path $tempDir 'egoliteSetup.exe'
      Write-Log ('Downloading ego lite installer from {0} ...' -f $setupUrl)
      if (-not $Elevated) {
        Write-Log 'If Windows asks for permission, choose Yes to install.'
      }
      Save-Installer $setupUrl $setup
      Assert-InstallerSignature $setup
      Write-Log 'Installer downloaded and verified.'
      try {
        $exitCode = Invoke-Installer $setup
      } catch [System.ComponentModel.Win32Exception] {
        # The installer is an x64 program. Windows on Arm releases without x64
        # emulation, such as Windows 10 before build 21277, cannot start it and
        # report ERROR_BAD_EXE_FORMAT (193) or ERROR_EXE_MACHINE_TYPE_MISMATCH
        # (216).
        if ($architecture -ne 'ARM64' -or
            @(193, 216) -notcontains $_.Exception.NativeErrorCode) {
          throw
        }
        Stop-Script (('could not start the x64 installer (Windows error ' +
                      '{0}). This Windows on Arm may not be able to run x64 ' +
                      'programs; update to Windows 11.') -f
                     $_.Exception.NativeErrorCode)
      }
    } finally {
      Remove-TempDir $tempDir
    }
    if ($exitCode -eq 0) {
      return
    }
    # Pass the installer's code on, except codes whose low 8 bits are 0, such
    # as 75008: Git Bash keeps only those bits and would report success.
    $scriptExitCode = $exitCode
    if (($exitCode -band 0xFF) -eq 0) {
      $scriptExitCode = 1
    }
    if ($exitCode -eq $SetupLockedExitCode) {
      Stop-Script ('another ego lite installation is running (exit code ' +
                   '75075). Wait for it to finish, then run install.ps1 ' +
                   'again.') $scriptExitCode
    }
    if ($exitCode -eq $SetupRegistrationFailedExitCode) {
      Stop-Script ('ego lite updater registration failed (exit code 75003, ' +
                   '0x000124FB). Run install.ps1 again and choose Yes in ' +
                   'the Windows permission (UAC) prompt, or ask the user ' +
                   'to download and run the official installer from ' +
                   $DownloadPageUrl + ' outside the agent terminal.') `
          $scriptExitCode
    }
    Stop-Script (('the ego lite installer failed with exit code {0} ' +
                  '(0x{0:X8}). Check updater.log under "Citro Labs\EgoUpdater" ' +
                  'in Program Files (x86) or %LOCALAPPDATA% for details, ' +
                  'or install ego ' +
                  'lite from ' + $DownloadPageUrl) -f $exitCode) $scriptExitCode
  }

  function Invoke-Main {
    $windowsMajorVersion = Get-RegistryValue 'LocalMachine' 'Registry64' `
        'SOFTWARE\Microsoft\Windows NT\CurrentVersion' `
        'CurrentMajorVersionNumber'
    if ([int]$windowsMajorVersion -lt $MinimumWindowsMajorVersion) {
      Stop-Script 'install.ps1 requires Windows 10 or later.'
    }

    $applicationDir = Find-InstallDirectory
    $cli = $null
    if ($applicationDir) {
      $cli = Get-CliPath $applicationDir
    }

    # Earlier versions forwarded arguments to ego-browser; fail loudly rather
    # than let a caller believe its command ran.
    if ($ScriptArgs.Count -gt 0) {
      if (-not $applicationDir) {
        Stop-Script ('install.ps1 takes no arguments. ego lite is not ' +
                     'installed; run install.ps1 without arguments to ' +
                     'install it, then use ego-browser for other commands.')
      }
      $where = ''
      if ($cli) {
        $where = ' at "' + $cli + '"'
      }
      Stop-Script ('install.ps1 takes no arguments; it only installs ego ' +
                   'lite. Run ego-browser' + $where + ' directly for other ' +
                   'commands.')
    }

    if ($applicationDir) {
      Write-Log 'ego lite is already installed; no need to install it again.'
      if ($cli) {
        Write-CliUsage $cli $false
      } else {
        Write-Log ('warning: ego lite is installed in "' + $applicationDir +
                   '", but its ego-browser was not found. Reinstall ego lite ' +
                   'from ' + $DownloadPageUrl)
      }
      return 0
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.IsSystem) {
      Stop-Script 'run install.ps1 as the signed-in user, not as SYSTEM.'
    }
    $principal = New-Object Security.Principal.WindowsPrincipal $identity
    $elevated = $principal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    Install-EgoLite $elevated

    $applicationDir = Find-InstallDirectory
    if (-not $applicationDir) {
      Stop-Script ('the ego lite installer exited with code 0, but ego lite ' +
                   'was not found where it installs. The installer log is ' +
                   'updater.log under "Citro Labs\EgoUpdater" in Program ' +
                   'Files (x86) or in %LOCALAPPDATA%.')
    }
    return (Start-Onboarding $applicationDir $elevated)
  }

  # Tells whether a user types commands into this session, so that exit
  # would close their window. The console host reads typed commands unless
  # its input is redirected or it ends after -Command or -File, which only
  # its own noExit flag tells reliably (_noExit in PowerShell 7). Other
  # hosts, such as the ISE, are treated as typed into.
  function Test-TypedSession {
    if ($Host.Name -ne 'ConsoleHost') {
      return $true
    }
    # Input from a pipe or a file comes from a program, which wants the code.
    if ([Console]::IsInputRedirected) {
      return $false
    }
    try {
      $flags = [Reflection.BindingFlags]'Instance, NonPublic'
      $console = $Host.GetType().GetProperty('ExternalHost', $flags).GetValue(
          $Host, $null)
      foreach ($name in @('noExit', '_noExit')) {
        $field = $console.GetType().GetField($name, $flags)
        if ($field) {
          return [bool]$field.GetValue($console)
        }
      }
    } catch {
    }
    # Without the flag, keep exit codes reliable rather than windows open.
    return $false
  }

  $exitCode = 0
  $callerUICulture = [Threading.Thread]::CurrentThread.CurrentUICulture
  try {
    # Temporarily use English messages on this PowerShell thread only;
    # this does not change Windows settings. Restore the language in finally.
    [Threading.Thread]::CurrentThread.CurrentUICulture =
        [Globalization.CultureInfo]::GetCultureInfo('en-US')
    # The cast fails loudly should anything in Invoke-Main write output
    # besides its exit code.
    $exitCode = [int](Invoke-Main)
  } catch {
    if ($_.Exception.Data.Contains($ExitCodeKey)) {
      $exitCode = $_.Exception.Data[$ExitCodeKey]
    } else {
      Write-Log ('error: {0} (install.ps1 line {1})' -f
                 $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber)
      $exitCode = 1
    }
  } finally {
    [Threading.Thread]::CurrentThread.CurrentUICulture = $callerUICulture
  }

  # exit ends only this script when it runs from a file. Through
  # Invoke-Expression it ends the whole session, which passes the code on to
  # a program but would close a window that the user typed the command into.
  # $MyInvocation.ScriptName is the file that called this block, if any.
  if ($MyInvocation.ScriptName -or -not (Test-TypedSession)) {
    exit $exitCode
  }
  $global:LASTEXITCODE = $exitCode
} @args
