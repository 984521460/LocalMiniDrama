#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>

#include <cstring>

namespace {

FARPROC WINAPI LoadHostExecutable(unsigned int event, DelayLoadInfo* information) {
  if (event != dliNotePreLoadLibrary || information == nullptr
      || information->szDll == nullptr
      || _stricmp(information->szDll, "node.exe") != 0) return nullptr;
  HMODULE host = GetModuleHandleW(L"libnode.dll");
  if (host == nullptr) host = GetModuleHandleW(nullptr);
  return reinterpret_cast<FARPROC>(host);
}

}  // namespace

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = LoadHostExecutable;
