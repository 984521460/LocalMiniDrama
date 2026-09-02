const {
  CredentialBridgeError,
  PowerShellCredentialBridge,
} = require('./powershellCredentialBridge');
const {
  getWindowsCredentialErrorCode,
  getWindowsCredentialErrorCredentialRef,
  WindowsCredentialError,
  WindowsCredentialVault,
} = require('./windowsCredentialVault');

module.exports = {
  CredentialBridgeError,
  getWindowsCredentialErrorCode,
  getWindowsCredentialErrorCredentialRef,
  PowerShellCredentialBridge,
  WindowsCredentialError,
  WindowsCredentialVault,
};
