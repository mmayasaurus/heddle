# Windows PowerShell 5.1 / .NET Framework. This file is code only; request/secret bytes arrive on stdin.
# SYSTEM and BUILTIN\Administrators are trusted OS principals (they can already take ownership).
# Other principals may read directory listings, but may neither mutate directories nor access secrets.
# Files and directories are created WITH a protected current-SID DACL, never create-then-chmod.
# References:
# https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.-ctor?view=netframework-4.8.1
# https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.getaccesscontrol?view=netframework-4.8.1
# https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1
# https://learn.microsoft.com/en-us/windows/win32/fileio/moving-and-replacing-files
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Avoid utility-module discovery in the deliberately restricted child environment.
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json = [Web.Script.Serialization.JavaScriptSerializer]::new()
# Base64 adds one third to the runner's 32 MiB retained worker output.
$json.MaxJsonLength = 64 * 1024 * 1024
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')

function Refuse([string] $reason) { throw [InvalidOperationException]::new($reason) }

function Normalize-Path([string] $path) {
    # No UNC/device namespace, DOS device, alternate data stream, dot/space alias, or parent traversal.
    # These aliases evade ordinary path-component/reparse validation. Credentials use local disk paths.
    if ([string]::IsNullOrWhiteSpace($path) -or $path.StartsWith('\\') -or $path.StartsWith('//')) { Refuse 'PATH' }
    $parts = $path -split '[\\/]'
    foreach ($part in $parts) {
        if ($part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { Refuse 'PATH' }
        if ($part.Contains(':') -and $part -notmatch '^[A-Za-z]:$') { Refuse 'PATH' }
    }
    $full = [IO.Path]::GetFullPath($path)
    if ($full -notmatch '^[A-Za-z]:\\') { Refuse 'PATH' }
    if ($full.Length -gt 3) { return $full.TrimEnd('\') }
    return $full
}

function Assert-Acl($acl, [bool] $directory, [bool] $requireOwner) {
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (($requireOwner -and $owner -ne $sid.Value) -or $trusted -notcontains $owner) { Refuse 'ACL' }
    # RawSecurityDescriptor preserves null DACL semantics. Enumerating AccessRules alone would mistake
    # a null DACL (everyone has access) for an empty DACL (nobody has access).
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -eq 0 -or $null -eq $raw.DiscretionaryAcl) { Refuse 'ACL' }
    # Directory read-only grants are equivalent to an accepted POSIX 0755 directory. Everything outside
    # ReadAndExecute/Synchronize is conservatively a mutation/unknown right and is refused.
    $readOnly = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [int][Security.AccessControl.FileSystemRights]::Synchronize
    foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { Refuse 'ACL' }
        if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
        if ($trusted -contains $ace.SecurityIdentifier.Value) { continue }
        # Inherit-only directory grants still control children created by native CLIs; validate them too.
        if (!$directory -or ($ace.AccessMask -band (-bnot $readOnly)) -ne 0) { Refuse 'ACL' }
    }
}

function Assert-Type([string] $path, [bool] $directory) {
    $attributes = [IO.File]::GetAttributes($path) # throws ENOENT; Exists() would hide access errors
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'REPARSE' }
    if ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { Refuse 'TYPE' }
}

function Assert-Directory([string] $path, [bool] $requireOwner = $true, [bool] $private = $false) {
    Assert-Type $path $true
    $acl = [IO.Directory]::GetAccessControl($path)
    Assert-Acl $acl (!$private) $requireOwner
    if ($private) {
        # SQLite and native CLIs create children themselves. A private ACL on this directory alone
        # does not secure those children: they need an inheritable ACE rather than a token-default DACL.
        $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        $full = [Security.AccessControl.FileSystemRights]::FullControl
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                $rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band $full) -eq $full -and
                ($rule.InheritanceFlags -band $inherit) -eq $inherit -and
                ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -eq 0) { return }
        }
        Refuse 'INHERITANCE'
    }
}

# Returns an in-memory descriptor; applying it to a filesystem object happens at the caller.
function Get-PrivateAcl([bool] $directory) {
    if ($directory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    if ($directory) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    } else {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
    }
    $acl.AddAccessRule($rule)
    return $acl
}

function Is-Missing($errorRecord) {
    $exception = $errorRecord.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    return ($exception -is [IO.FileNotFoundException] -or $exception -is [IO.DirectoryNotFoundException])
}

function Assert-Ancestors([string] $from, [string] $boundary) {
    $current = $from
    while (![string]::Equals($current, $boundary, [StringComparison]::OrdinalIgnoreCase)) {
        Assert-Directory $current $false
        $next = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($next) -or $next -eq $current) { Refuse 'BOUNDARY' }
        $current = $next
    }
}

function Ensure-Directory([string] $path, [string] $boundary = '', [bool] $checkParent = $false, [bool] $private = $false) {
    if ($boundary -and !$path.StartsWith($boundary.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { Refuse 'BOUNDARY' }
    $missing = [Collections.Generic.List[string]]::new()
    $current = $path
    while ($true) {
        try { Assert-Directory $current ($current -eq $path) ($private -and $current -eq $path); break }
        catch { if (!(Is-Missing $_)) { throw } }
        $missing.Insert(0, $current)
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { Refuse 'PATH' }
        $current = $parent
    }
    if ($checkParent -and $missing.Count -eq 0) { Assert-Directory ([IO.Path]::GetDirectoryName($path)) $false }
    if ($boundary) {
        $from = if ($missing.Count -eq 0) { [IO.Path]::GetDirectoryName($path) } else { $current }
        if ($from -eq $boundary -or $from.StartsWith($boundary.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { Assert-Ancestors $from $boundary }
    }
    foreach ($component in $missing) {
        # Parent was validated before descent. The framework overload applies the DACL at creation.
        # A concurrent directory creator is accepted only after validating its actual owner and ACL.
        [void][IO.Directory]::CreateDirectory($component, (Get-PrivateAcl $true))
        Assert-Directory $component $true $true
    }
}

function Open-PrivateRead([string] $path, [bool] $assertOnly = $false, [bool] $requireOwner = $true) {
    Assert-Type $path $false
    # SQLite callers inspect existing DB/WAL/SHM while cooperating writers hold them. Validation-only
    # handles share writes/deletes; secret reads keep a stable, non-writable handle until bytes are read.
    $sharing = [IO.FileShare]::Read
    if ($assertOnly) { $sharing = [IO.FileShare]'ReadWrite,Delete' }
    $stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [Security.AccessControl.FileSystemRights]::Read,
        $sharing, 4096, [IO.FileOptions]::None)
    try { Assert-Acl ($stream.GetAccessControl()) $false $requireOwner; return $stream }
    catch { $stream.Dispose(); throw }
}

function Create-PrivateFile([string] $path, [byte[]] $bytes) {
    $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl,
        [IO.FileShare]::None, 4096, [IO.FileOptions]::None, (Get-PrivateAcl $false))
    try {
        Assert-Acl ($stream.GetAccessControl()) $false $true
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

$recoveryFile = $null
try {
    # Avoid JSON pipeline cmdlets: PowerShell module logging can record their parameter/input values.
    # Only fixed script source is executable; the request is deserialized as data by the framework.
    $request = $json.DeserializeObject([Console]::In.ReadLine())
    $path = Normalize-Path $request.path
    $parent = [IO.Path]::GetDirectoryName($path)
    $result = @{ ok = $true }
    switch ($request.operation) {
        'assert-dir' { Assert-Directory $path ([bool]$request.requireOwner) $true }
        'ensure-dir' {
            $boundary = ''
            if ($request.ContainsKey('boundary')) { $boundary = Normalize-Path $request.boundary }
            Ensure-Directory $path $boundary $true $true
        }
        'assert-private-file' {
            Assert-Directory $parent
            $stream = Open-PrivateRead $path $true
            $stream.Dispose()
        }
        'assert-sqlite-sidecar' {
            if ($path -notmatch '-(?:wal|shm|journal)$') { Refuse 'PATH' }
            Assert-Directory $parent $true $true
            # SQLite uses its token's default owner, which may be Administrators when elevated.
            # Reuse the trusted system principals, while preserving the full private-DACL checks.
            $stream = Open-PrivateRead $path $true $false
            $stream.Dispose()
        }
        { $_ -eq 'read' -or $_ -eq 'inspect-lock' } {
            Assert-Directory $parent
            $stream = Open-PrivateRead $path
            try {
                $memory = [IO.MemoryStream]::new()
                try { $stream.CopyTo($memory); $result.content = [Convert]::ToBase64String($memory.ToArray()) }
                finally { $memory.Dispose() }
                if ($request.operation -eq 'inspect-lock') {
                    $result.mtimeMs = [DateTimeOffset]::new([IO.File]::GetLastWriteTimeUtc($path)).ToUnixTimeMilliseconds()
                }
            } finally { $stream.Dispose() }
        }
        { $_ -eq 'write' -or $_ -eq 'create-file' } {
            Ensure-Directory $parent
            if ($request.operation -eq 'create-file') {
                Create-PrivateFile $path ([Convert]::FromBase64String($request.content))
            } else {
                $present = $false
                try { $old = Open-PrivateRead $path; $old.Dispose(); $present = $true }
                catch { if (!(Is-Missing $_)) { throw } }
                $temporary = [IO.Path]::Combine($parent, '.' + [guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    Create-PrivateFile $temporary ([Convert]::FromBase64String($request.content))
                    # ReplaceFile retains the old ACL: unlike POSIX, a permissive existing file is
                    # REFUSED above, never silently carried into the replacement. No unlink window.
                    if (!$present) {
                        try { [IO.File]::Move($temporary, $path) } # exclusive first publication
                        catch {
                            $moveError = $_.Exception
                            while ($null -ne $moveError.InnerException) { $moveError = $moveError.InnerException }
                            # Another writer can publish after our initial absent-target check. Only
                            # native file-exists errors admit a replacement attempt; sharing/access/disk
                            # failures keep their original failure path and private recovery evidence.
                            if ($moveError -isnot [IO.IOException] -or @(80, 183) -notcontains ($moveError.HResult -band 0xFFFF)) { throw }
                            $winner = Open-PrivateRead $path
                            $winner.Dispose() # rejects foreign ACL/owner, reparse points and non-files
                            $present = $true
                        }
                    }
                    # PowerShell converts $null to an empty string for a .NET string parameter.
                    # Replace requires a true null backup path, not an invalid empty filename.
                    if ($present) { [IO.File]::Replace($temporary, $path, [System.Management.Automation.Language.NullString]::Value) }
                } catch {
                    # ReplaceFile can fail AFTER removing the destination (Win32 error 1176), leaving
                    # this private temp as the only surviving new content. A successful publication
                    # consumes the temp name itself; a failed publication must NEVER delete it.
                    # The destination may be absent on failure: retain recovery evidence and stop.
                    if ([IO.File]::Exists($temporary)) { $recoveryFile = [IO.Path]::GetFileName($temporary) }
                    throw
                }
            }
        }
        default { Refuse 'PATH' }
    }
    [Console]::Out.Write($json.Serialize($result))
} catch {
    # Never print raw exceptions, paths, request data, or PowerShell ErrorRecords.
    $exception = $_.Exception
    while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
    $reason = 'IO'; $code = 'EIO'
    if ($exception -is [InvalidOperationException] -and @('ACL','REPARSE','TYPE','PATH','BOUNDARY','INHERITANCE') -contains $exception.Message) {
        $reason = $exception.Message; $code = 'EACCES'
    } elseif ($exception -is [IO.FileNotFoundException] -or $exception -is [IO.DirectoryNotFoundException]) { $code = 'ENOENT' }
    elseif ($exception -is [UnauthorizedAccessException]) { $code = 'EACCES' }
    else {
        switch ($exception.HResult -band 0xFFFF) {
            80 { $code = 'EEXIST' }; 183 { $code = 'EEXIST' }; 32 { $code = 'EBUSY' }; 33 { $code = 'EBUSY' }
        }
    }
    $failure = @{ ok = $false; code = $code; reason = $reason }
    if ($null -ne $recoveryFile) { $failure.reason = 'RECOVERY'; $failure.recoveryFile = $recoveryFile }
    [Console]::Out.Write($json.Serialize($failure))
}
