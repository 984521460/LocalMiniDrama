#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <node_api.h>

#include <algorithm>
#include <cstdint>
#include <cwctype>
#include <exception>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <vector>

namespace {

constexpr const char* kErrorCode = "LOG_DIRECTORY_LEASE_INVALID";
constexpr const char* kErrorMessage = "Log directory lease invalid";

#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif

constexpr ULONG kFileOpen = 1;
constexpr ULONG kFileCreate = 2;
constexpr ULONG kFileOpenIf = 3;
constexpr ULONG kFileSynchronousIoNonAlert = 0x00000020;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;
constexpr size_t kMaxDirectoryDepth = 64;
constexpr size_t kMaxDirectorySegmentCharacters = 240;

using NtCreateFileFunction = NTSTATUS(NTAPI*)(
  PHANDLE,
  ACCESS_MASK,
  POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK,
  PLARGE_INTEGER,
  ULONG,
  ULONG,
  ULONG,
  ULONG,
  PVOID,
  ULONG
);
using RtlNtStatusToDosErrorFunction = ULONG(WINAPI*)(NTSTATUS);

struct FileIdentity {
  uint64_t device = 0;
  uint64_t inode = 0;
  uint64_t size = 0;
};

struct DirectoryLease {
  std::vector<HANDLE> handles;
  bool released = false;

  ~DirectoryLease() {
    for (auto iterator = handles.rbegin(); iterator != handles.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE && *iterator != nullptr) CloseHandle(*iterator);
    }
    handles.clear();
    released = true;
  }
};

void ThrowFixed(napi_env env) {
  napi_value code;
  napi_value message;
  napi_create_string_utf8(env, kErrorCode, NAPI_AUTO_LENGTH, &code);
  napi_create_string_utf8(env, kErrorMessage, NAPI_AUTO_LENGTH, &message);
  napi_value error;
  napi_create_error(env, code, message, &error);
  napi_throw(env, error);
}

bool Utf8String(napi_env env, napi_value value, std::string* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok
      || length == 0 || length > 32 * 1024) return false;
  std::vector<char> buffer(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &copied) != napi_ok
      || copied != length) return false;
  output->assign(buffer.data(), copied);
  return true;
}

bool Uint64BigInt(napi_env env, napi_value value, uint64_t* output) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_bigint) return false;
  bool lossless = false;
  return napi_get_value_bigint_uint64(env, value, output, &lossless) == napi_ok && lossless;
}

bool Utf8ToWide(const std::string& input, std::wstring* output) {
  const int required = MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    input.data(),
    static_cast<int>(input.size()),
    nullptr,
    0
  );
  if (required <= 0 || required > 32 * 1024) return false;
  output->assign(static_cast<size_t>(required), L'\0');
  return MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    input.data(),
    static_cast<int>(input.size()),
    output->data(),
    required
  ) == required;
}

void TrimTrailingSeparators(std::wstring* value) {
  while (value->size() > 3 && (value->back() == L'\\' || value->back() == L'/')) {
    value->pop_back();
  }
}

std::wstring ComparablePath(std::wstring value) {
  if (value.rfind(L"\\\\?\\UNC\\", 0) == 0) {
    value = L"\\\\" + value.substr(8);
  } else if (value.rfind(L"\\\\?\\", 0) == 0) {
    value = value.substr(4);
  }
  std::replace(value.begin(), value.end(), L'/', L'\\');
  TrimTrailingSeparators(&value);
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return value;
}

bool AbsoluteDrivePath(const std::wstring& input, std::wstring* output) {
  if (input.size() < 3 || input[1] != L':' || (input[2] != L'\\' && input[2] != L'/')) return false;
  if (!std::iswalpha(input[0])) return false;
  const DWORD required = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (required == 0 || required > 32 * 1024) return false;
  std::vector<wchar_t> buffer(static_cast<size_t>(required) + 1, L'\0');
  const DWORD copied = GetFullPathNameW(input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (copied == 0 || copied >= buffer.size()) return false;
  output->assign(buffer.data(), copied);
  std::replace(output->begin(), output->end(), L'/', L'\\');
  TrimTrailingSeparators(output);
  return ComparablePath(*output) == ComparablePath(input);
}

bool ValidDirectoryPath(const std::wstring& directory) {
  if (directory.size() < 3 || directory[1] != L':' || directory[2] != L'\\') return false;
  size_t cursor = 3;
  size_t depth = 0;
  while (cursor < directory.size()) {
    const size_t separator = directory.find(L'\\', cursor);
    const size_t end = separator == std::wstring::npos ? directory.size() : separator;
    const size_t length = end - cursor;
    if (length == 0 || length > kMaxDirectorySegmentCharacters
        || (length == 1 && directory[cursor] == L'.')
        || (length == 2 && directory[cursor] == L'.' && directory[cursor + 1] == L'.')
        || directory.find(L':', cursor) < end
        || ++depth > kMaxDirectoryDepth) return false;
    if (separator == std::wstring::npos) break;
    cursor = separator + 1;
  }
  return true;
}

bool FinalPathForHandle(HANDLE handle, std::wstring* output) {
  std::vector<wchar_t> buffer(32 * 1024, L'\0');
  const DWORD copied = GetFinalPathNameByHandleW(
    handle,
    buffer.data(),
    static_cast<DWORD>(buffer.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
  );
  if (copied == 0 || copied >= buffer.size()) return false;
  output->assign(buffer.data(), copied);
  return true;
}

bool OpenDirectoryChain(
  const std::wstring& directory,
  uint64_t expected_device,
  uint64_t expected_inode,
  DirectoryLease* lease
) {
  if (!ValidDirectoryPath(directory)) return false;

  std::wstring current = directory.substr(0, 3);
  size_t cursor = 3;
  while (true) {
    HANDLE handle = CreateFileW(
      current.c_str(),
      FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr
    );
    if (handle == INVALID_HANDLE_VALUE) return false;
    try {
      lease->handles.push_back(handle);
    } catch (...) {
      CloseHandle(handle);
      throw;
    }

    FILE_ATTRIBUTE_TAG_INFO tag_info{};
    if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag_info, sizeof(tag_info))
        || (tag_info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
        || (tag_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;

    std::wstring final_path;
    if (!FinalPathForHandle(handle, &final_path)
        || ComparablePath(final_path) != ComparablePath(current)) return false;

    if (current.size() == directory.size()) {
      BY_HANDLE_FILE_INFORMATION information{};
      if (!GetFileInformationByHandle(handle, &information)) return false;
      const uint64_t inode = (static_cast<uint64_t>(information.nFileIndexHigh) << 32)
        | static_cast<uint64_t>(information.nFileIndexLow);
      if (expected_device != static_cast<uint64_t>(information.dwVolumeSerialNumber)
          || expected_inode != inode) return false;
      break;
    }

    const size_t separator = directory.find(L'\\', cursor);
    const size_t end = separator == std::wstring::npos ? directory.size() : separator;
    if (current.size() > 3) current.push_back(L'\\');
    current.append(directory, cursor, end - cursor);
    cursor = separator == std::wstring::npos ? directory.size() : separator + 1;
  }
  return true;
}

bool SafeLeafName(const std::wstring& value) {
  if (value.empty() || value.size() > 240 || value == L"." || value == L".."
      || value.back() == L'.' || value.back() == L' ') return false;
  for (wchar_t character : value) {
    if (character < 32 || character == L'\\' || character == L'/' || character == L':'
        || character == L'"' || character == L'<' || character == L'>' || character == L'|'
        || character == L'?' || character == L'*') return false;
  }
  return true;
}

NtCreateFileFunction NtCreateFileApi() {
  static const auto function = reinterpret_cast<NtCreateFileFunction>(
    GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile")
  );
  return function;
}

RtlNtStatusToDosErrorFunction RtlNtStatusToDosErrorApi() {
  static const auto function = reinterpret_cast<RtlNtStatusToDosErrorFunction>(
    GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlNtStatusToDosError")
  );
  return function;
}

bool OpenRelative(
  DirectoryLease* lease,
  const std::wstring& name,
  ACCESS_MASK access,
  ULONG disposition,
  HANDLE* output,
  bool* not_found = nullptr,
  ULONG share_mode = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
) {
  if (not_found != nullptr) *not_found = false;
  if (lease == nullptr || lease->released || lease->handles.empty() || !SafeLeafName(name)) return false;
  const auto nt_create_file = NtCreateFileApi();
  const auto nt_status_to_dos_error = RtlNtStatusToDosErrorApi();
  if (nt_create_file == nullptr || nt_status_to_dos_error == nullptr) return false;
  if (name.size() > (std::numeric_limits<USHORT>::max() / sizeof(wchar_t))) return false;

  UNICODE_STRING object_name{};
  object_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  object_name.Buffer = const_cast<PWSTR>(name.data());
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = lease->handles.back();
  attributes.ObjectName = &object_name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK status_block{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  const NTSTATUS status = nt_create_file(
    &handle,
    access,
    &attributes,
    &status_block,
    nullptr,
    FILE_ATTRIBUTE_NORMAL,
    share_mode,
    disposition,
    kFileSynchronousIoNonAlert | kFileNonDirectoryFile | kFileOpenReparsePoint,
    nullptr,
    0
  );
  if (!NT_SUCCESS(status)) {
    const ULONG error = nt_status_to_dos_error(status);
    if (not_found != nullptr && (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)) {
      *not_found = true;
    }
    return false;
  }
  *output = handle;
  return true;
}

bool RegularFileIdentity(HANDLE handle, FileIdentity* output) {
  FILE_ATTRIBUTE_TAG_INFO tag_info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag_info, sizeof(tag_info))
      || (tag_info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
      || (tag_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(handle, &information) || information.nNumberOfLinks != 1) return false;
  output->device = static_cast<uint64_t>(information.dwVolumeSerialNumber);
  output->inode = (static_cast<uint64_t>(information.nFileIndexHigh) << 32)
    | static_cast<uint64_t>(information.nFileIndexLow);
  output->size = (static_cast<uint64_t>(information.nFileSizeHigh) << 32)
    | static_cast<uint64_t>(information.nFileSizeLow);
  return true;
}

bool SameFileIdentity(const FileIdentity& left, const FileIdentity& right) {
  return left.device == right.device && left.inode == right.inode;
}

bool StatRelative(
  DirectoryLease* lease,
  const std::wstring& name,
  bool* exists,
  FileIdentity* identity
) {
  *exists = false;
  HANDLE handle = INVALID_HANDLE_VALUE;
  bool not_found = false;
  if (!OpenRelative(
        lease,
        name,
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        kFileOpen,
        &handle,
        &not_found
      )) return not_found;
  const bool valid = RegularFileIdentity(handle, identity);
  const bool closed = CloseHandle(handle) != 0;
  if (!valid || !closed) return false;
  *exists = true;
  return true;
}

bool DeleteRelative(DirectoryLease* lease, const std::wstring& name) {
  HANDLE handle = INVALID_HANDLE_VALUE;
  bool not_found = false;
  if (!OpenRelative(
        lease,
        name,
        DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        kFileOpen,
        &handle,
        &not_found
      )) return not_found;
  FileIdentity identity{};
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  const bool deleted = RegularFileIdentity(handle, &identity)
    && SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition)) != 0;
  const bool closed = CloseHandle(handle) != 0;
  if (!deleted || !closed) return false;
  bool exists = false;
  FileIdentity after{};
  return StatRelative(lease, name, &exists, &after) && !exists;
}

bool CopyAndDeleteRelative(
  DirectoryLease* lease,
  const std::wstring& source,
  const std::wstring& destination
) {
  std::vector<uint8_t> copy_buffer(64 * 1024);
  HANDLE source_handle = INVALID_HANDLE_VALUE;
  if (!OpenRelative(
        lease,
        source,
        GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        kFileOpen,
        &source_handle,
        nullptr,
        FILE_SHARE_READ
      )) return false;
  FileIdentity source_identity{};
  if (!RegularFileIdentity(source_handle, &source_identity) || source_identity.size > (1ULL << 30)) {
    CloseHandle(source_handle);
    return false;
  }

  HANDLE destination_handle = INVALID_HANDLE_VALUE;
  if (!OpenRelative(
        lease,
        destination,
        GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        kFileCreate,
        &destination_handle,
        nullptr,
        FILE_SHARE_READ
      )) {
    CloseHandle(source_handle);
    return false;
  }
  FileIdentity destination_identity{};
  if (!RegularFileIdentity(destination_handle, &destination_identity)
      || SameFileIdentity(source_identity, destination_identity)) {
    CloseHandle(destination_handle);
    CloseHandle(source_handle);
    return false;
  }

  uint64_t copied = 0;
  bool copy_succeeded = true;
  while (copied < source_identity.size) {
    const DWORD requested = static_cast<DWORD>(std::min<uint64_t>(
      copy_buffer.size(),
      source_identity.size - copied
    ));
    DWORD read = 0;
    DWORD written = 0;
    if (!ReadFile(source_handle, copy_buffer.data(), requested, &read, nullptr)
        || read != requested
        || !WriteFile(destination_handle, copy_buffer.data(), read, &written, nullptr)
        || written != read) {
      copy_succeeded = false;
      break;
    }
    copied += read;
  }
  DWORD eof_read = 0;
  uint8_t eof_byte = 0;
  FileIdentity source_after{};
  FileIdentity destination_after{};
  copy_succeeded = copy_succeeded
    && ReadFile(source_handle, &eof_byte, 1, &eof_read, nullptr) != 0
    && eof_read == 0
    && FlushFileBuffers(destination_handle) != 0
    && RegularFileIdentity(source_handle, &source_after)
    && RegularFileIdentity(destination_handle, &destination_after)
    && SameFileIdentity(source_identity, source_after)
    && source_after.size == source_identity.size
    && destination_after.size == source_identity.size;
  const bool destination_closed = CloseHandle(destination_handle) != 0;
  const bool source_closed = CloseHandle(source_handle) != 0;
  if (!copy_succeeded || !destination_closed || !source_closed) {
    DeleteRelative(lease, destination);
    return false;
  }
  return DeleteRelative(lease, source);
}

std::wstring BackupName(const std::wstring& name, uint32_t index) {
  return name + L"." + std::to_wstring(index);
}

bool AppendRelative(
  DirectoryLease* lease,
  const std::wstring& name,
  const uint8_t* data,
  size_t length
) {
  HANDLE handle = INVALID_HANDLE_VALUE;
  if (!OpenRelative(
        lease,
        name,
        FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        kFileOpenIf,
        &handle
      )) return false;
  FileIdentity before{};
  LARGE_INTEGER zero{};
  DWORD written = 0;
  const bool valid = RegularFileIdentity(handle, &before)
    && SetFilePointerEx(handle, zero, nullptr, FILE_END) != 0
    && length <= std::numeric_limits<DWORD>::max()
    && WriteFile(handle, data, static_cast<DWORD>(length), &written, nullptr) != 0
    && written == length
    && FlushFileBuffers(handle) != 0;
  FileIdentity after{};
  const bool stable = valid && RegularFileIdentity(handle, &after)
    && SameFileIdentity(before, after) && after.size == before.size + length;
  const bool closed = CloseHandle(handle) != 0;
  if (!stable || !closed) return false;
  bool exists = false;
  FileIdentity linked{};
  return StatRelative(lease, name, &exists, &linked)
    && exists && SameFileIdentity(after, linked) && after.size == linked.size;
}

bool AppendBoundedLog(
  DirectoryLease* lease,
  const std::wstring& name,
  const uint8_t* data,
  size_t length,
  uint64_t max_file_bytes,
  uint32_t max_backups
) {
  if (lease == nullptr || lease->released || !SafeLeafName(name) || length == 0
      || length > max_file_bytes || max_file_bytes == 0 || max_backups > 100) return false;
  for (uint32_t index = 1; index <= max_backups; ++index) {
    bool exists = false;
    FileIdentity backup{};
    if (!StatRelative(lease, BackupName(name, index), &exists, &backup)) return false;
    if (exists && backup.size > max_file_bytes && !DeleteRelative(lease, BackupName(name, index))) {
      return false;
    }
  }

  bool current_exists = false;
  FileIdentity current{};
  if (!StatRelative(lease, name, &current_exists, &current)) return false;
  if (current_exists && current.size + length > max_file_bytes) {
    if (max_backups == 0) {
      if (!DeleteRelative(lease, name)) return false;
    } else {
      if (!DeleteRelative(lease, BackupName(name, max_backups))) return false;
      for (uint32_t index = max_backups; index > 1; --index) {
        const std::wstring source = BackupName(name, index - 1);
        bool exists = false;
        FileIdentity backup{};
        if (!StatRelative(lease, source, &exists, &backup)) return false;
        if (exists && !CopyAndDeleteRelative(lease, source, BackupName(name, index))) return false;
      }
      if (current.size <= max_file_bytes) {
        if (!CopyAndDeleteRelative(lease, name, BackupName(name, 1))) return false;
      } else if (!DeleteRelative(lease, name)) {
        return false;
      }
    }
  }
  return AppendRelative(lease, name, data, length);
}

napi_value AcquireDirectoryLeaseImpl(napi_env env, napi_callback_info info) {
  size_t argument_count = 3;
  napi_value arguments[3];
  if (napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr) != napi_ok
      || argument_count != 3) {
    ThrowFixed(env);
    return nullptr;
  }

  std::string directory_utf8;
  uint64_t expected_device = 0;
  uint64_t expected_inode = 0;
  if (!Utf8String(env, arguments[0], &directory_utf8)
      || !Uint64BigInt(env, arguments[1], &expected_device)
      || !Uint64BigInt(env, arguments[2], &expected_inode)) {
    ThrowFixed(env);
    return nullptr;
  }

  std::wstring directory_input;
  std::wstring directory;
  auto lease = std::make_unique<DirectoryLease>();
  if (!Utf8ToWide(directory_utf8, &directory_input)
      || !AbsoluteDrivePath(directory_input, &directory)
      || !OpenDirectoryChain(directory, expected_device, expected_inode, lease.get())) {
    ThrowFixed(env);
    return nullptr;
  }

  napi_value external;
  DirectoryLease* lease_data = lease.get();
  if (napi_create_external(
        env,
        lease_data,
        [](napi_env, void* data, void*) { delete static_cast<DirectoryLease*>(data); },
        nullptr,
        &external
      ) != napi_ok) {
    ThrowFixed(env);
    return nullptr;
  }
  lease.release();
  return external;
}

napi_value AppendBoundedLogFileImpl(napi_env env, napi_callback_info info) {
  size_t argument_count = 5;
  napi_value arguments[5];
  if (napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr) != napi_ok
      || argument_count != 5) {
    ThrowFixed(env);
    return nullptr;
  }
  void* lease_data = nullptr;
  std::string name_utf8;
  bool is_buffer = false;
  void* bytes = nullptr;
  size_t length = 0;
  int64_t max_file_bytes = 0;
  uint32_t max_backups = 0;
  if (napi_get_value_external(env, arguments[0], &lease_data) != napi_ok || lease_data == nullptr
      || !Utf8String(env, arguments[1], &name_utf8)
      || napi_is_buffer(env, arguments[2], &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, arguments[2], &bytes, &length) != napi_ok
      || bytes == nullptr || length == 0
      || napi_get_value_int64(env, arguments[3], &max_file_bytes) != napi_ok
      || max_file_bytes <= 0 || max_file_bytes > (1LL << 30)
      || napi_get_value_uint32(env, arguments[4], &max_backups) != napi_ok
      || max_backups > 100) {
    ThrowFixed(env);
    return nullptr;
  }
  std::wstring name;
  if (!Utf8ToWide(name_utf8, &name)
      || !AppendBoundedLog(
        static_cast<DirectoryLease*>(lease_data),
        name,
        static_cast<const uint8_t*>(bytes),
        length,
        static_cast<uint64_t>(max_file_bytes),
        max_backups
      )) {
    ThrowFixed(env);
    return nullptr;
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value ReleaseDirectoryLeaseImpl(napi_env env, napi_callback_info info) {
  size_t argument_count = 1;
  napi_value argument;
  if (napi_get_cb_info(env, info, &argument_count, &argument, nullptr, nullptr) != napi_ok
      || argument_count != 1) {
    ThrowFixed(env);
    return nullptr;
  }
  void* data = nullptr;
  if (napi_get_value_external(env, argument, &data) != napi_ok || data == nullptr) {
    ThrowFixed(env);
    return nullptr;
  }
  auto* lease = static_cast<DirectoryLease*>(data);
  bool success = !lease->released;
  if (!lease->released) {
    for (auto iterator = lease->handles.rbegin(); iterator != lease->handles.rend(); ++iterator) {
      if (*iterator != INVALID_HANDLE_VALUE && *iterator != nullptr && !CloseHandle(*iterator)) success = false;
      *iterator = INVALID_HANDLE_VALUE;
    }
    lease->handles.clear();
    lease->released = true;
  }
  napi_value result;
  napi_get_boolean(env, success, &result);
  return result;
}

napi_value AcquireDirectoryLease(napi_env env, napi_callback_info info) noexcept {
  try {
    return AcquireDirectoryLeaseImpl(env, info);
  } catch (const std::bad_alloc&) {
    ThrowFixed(env);
  } catch (const std::exception&) {
    ThrowFixed(env);
  } catch (...) {
    ThrowFixed(env);
  }
  return nullptr;
}

napi_value AppendBoundedLogFile(napi_env env, napi_callback_info info) noexcept {
  try {
    return AppendBoundedLogFileImpl(env, info);
  } catch (const std::bad_alloc&) {
    ThrowFixed(env);
  } catch (const std::exception&) {
    ThrowFixed(env);
  } catch (...) {
    ThrowFixed(env);
  }
  return nullptr;
}

napi_value ReleaseDirectoryLease(napi_env env, napi_callback_info info) noexcept {
  try {
    return ReleaseDirectoryLeaseImpl(env, info);
  } catch (const std::bad_alloc&) {
    ThrowFixed(env);
  } catch (const std::exception&) {
    ThrowFixed(env);
  } catch (...) {
    ThrowFixed(env);
  }
  return nullptr;
}

napi_value InitializeImpl(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "acquireDirectoryLease", nullptr, AcquireDirectoryLease, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "appendBoundedLog", nullptr, AppendBoundedLogFile, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "releaseDirectoryLease", nullptr, ReleaseDirectoryLease, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) {
    ThrowFixed(env);
    return nullptr;
  }
  return exports;
}

napi_value Initialize(napi_env env, napi_value exports) noexcept {
  try {
    return InitializeImpl(env, exports);
  } catch (const std::bad_alloc&) {
    ThrowFixed(env);
  } catch (const std::exception&) {
    ThrowFixed(env);
  } catch (...) {
    ThrowFixed(env);
  }
  return nullptr;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
