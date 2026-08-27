$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LocalMiniDramaCredentialNative
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public UInt32 Flags;
        public UInt32 Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);
}
'@

$CredentialTypeGeneric = 1
$CredentialPersistLocalMachine = 2
$ErrorNotFound = 1168
$TargetPattern = '^LocalMiniDrama/v1/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$UsernamePattern = '^(api_key|provider_token|ssh_password|ssh_key_passphrase)$'

function Write-BridgeResult {
    param([Parameter(Mandatory = $true)] [hashtable] $Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 4))
}

function Read-NativeCredential {
    param(
        [Parameter(Mandatory = $true)] [string] $Target,
        [switch] $IncludeSecret
    )
    $credentialPointer = [IntPtr]::Zero
    $found = [LocalMiniDramaCredentialNative]::CredRead(
        $Target,
        $CredentialTypeGeneric,
        0,
        [ref] $credentialPointer
    )
    if (-not $found) {
        if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $ErrorNotFound) {
            return $null
        }
        throw 'native-read-failed'
    }
    $credential = $null
    $credentialBlobSize = 0
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
            $credentialPointer,
            [type][LocalMiniDramaCredentialNative+CREDENTIAL]
        )
        $credentialBlobSize = [int] $credential.CredentialBlobSize
        if (
            $credentialBlobSize -lt 1 -or
            $credentialBlobSize -gt 2560 -or
            $credential.CredentialBlob -eq [IntPtr]::Zero
        ) {
            throw 'invalid-native-record'
        }
        if ($credential.UserName -notmatch $UsernamePattern) {
            throw 'invalid-native-record'
        }
        $result = @{ Username = [string] $credential.UserName }
        if ($IncludeSecret) {
            $secretBytes = New-Object byte[] $credentialBlobSize
            [Runtime.InteropServices.Marshal]::Copy(
                $credential.CredentialBlob,
                $secretBytes,
                0,
                $credentialBlobSize
            )
            $result.SecretBytes = $secretBytes
        }
        return $result
    }
    finally {
        if (
            $null -ne $credential -and
            $credential.CredentialBlob -ne [IntPtr]::Zero -and
            $credentialBlobSize -ge 1 -and
            $credentialBlobSize -le 2560
        ) {
            for ($index = 0; $index -lt $credentialBlobSize; $index += 1) {
                [Runtime.InteropServices.Marshal]::WriteByte($credential.CredentialBlob, $index, 0)
            }
        }
        [LocalMiniDramaCredentialNative]::CredFree($credentialPointer)
    }
}

try {
    $rawRequest = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($rawRequest) -or $rawRequest.Length -gt 16384) {
        throw 'invalid-request'
    }
    $request = $rawRequest | ConvertFrom-Json
    if ($null -eq $request -or $request.target -notmatch $TargetPattern) {
        throw 'invalid-target'
    }

    switch ($request.action) {
        'write' {
            if ($request.username -notmatch $UsernamePattern -or [string]::IsNullOrEmpty($request.secretBase64)) {
                throw 'invalid-write-request'
            }
            $secretBytes = [Convert]::FromBase64String([string] $request.secretBase64)
            if ($secretBytes.Length -lt 1 -or $secretBytes.Length -gt 2560) {
                [Array]::Clear($secretBytes, 0, $secretBytes.Length)
                throw 'invalid-secret-size'
            }
            $blob = [IntPtr]::Zero
            try {
                $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($secretBytes.Length)
                [Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blob, $secretBytes.Length)
                $credential = New-Object LocalMiniDramaCredentialNative+CREDENTIAL
                $credential.Type = $CredentialTypeGeneric
                $credential.TargetName = [string] $request.target
                $credential.CredentialBlobSize = $secretBytes.Length
                $credential.CredentialBlob = $blob
                $credential.Persist = $CredentialPersistLocalMachine
                $credential.UserName = [string] $request.username
                if (-not [LocalMiniDramaCredentialNative]::CredWrite([ref] $credential, 0)) {
                    throw 'native-write-failed'
                }
            }
            finally {
                if ($blob -ne [IntPtr]::Zero) {
                    for ($index = 0; $index -lt $secretBytes.Length; $index += 1) {
                        [Runtime.InteropServices.Marshal]::WriteByte($blob, $index, 0)
                    }
                    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
                }
                [Array]::Clear($secretBytes, 0, $secretBytes.Length)
            }
            Write-BridgeResult @{ ok = $true }
        }
        'read' {
            $record = Read-NativeCredential -Target ([string] $request.target) -IncludeSecret
            if ($null -eq $record) {
                Write-BridgeResult @{ found = $false }
                break
            }
            try {
                Write-BridgeResult @{
                    found = $true
                    username = [string] $record.Username
                    secretBase64 = [Convert]::ToBase64String($record.SecretBytes)
                }
            }
            finally {
                [Array]::Clear($record.SecretBytes, 0, $record.SecretBytes.Length)
            }
        }
        'inspect' {
            $record = Read-NativeCredential -Target ([string] $request.target)
            if ($null -eq $record) {
                Write-BridgeResult @{ found = $false }
                break
            }
            Write-BridgeResult @{ found = $true; username = [string] $record.Username }
        }
        'remove' {
            $removed = [LocalMiniDramaCredentialNative]::CredDelete(
                [string] $request.target,
                $CredentialTypeGeneric,
                0
            )
            if (-not $removed) {
                if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq $ErrorNotFound) {
                    Write-BridgeResult @{ removed = $false }
                    break
                }
                throw 'native-delete-failed'
            }
            Write-BridgeResult @{ removed = $true }
        }
        default {
            throw 'unsupported-action'
        }
    }
}
catch {
    [Console]::Error.WriteLine('credential-bridge-failed')
    exit 1
}
