"""Minimal Windows child-process ownership for the managed llama.cpp server."""

from __future__ import annotations

import ctypes
import ctypes.wintypes
from typing import Any


JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9


class _IOCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.wintypes.DWORD),
        ("SchedulingClass", ctypes.wintypes.DWORD),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IOCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
_kernel.CreateJobObjectW.restype = ctypes.wintypes.HANDLE
_kernel.SetInformationJobObject.argtypes = [
    ctypes.wintypes.HANDLE,
    ctypes.c_int,
    ctypes.c_void_p,
    ctypes.wintypes.DWORD,
]
_kernel.SetInformationJobObject.restype = ctypes.wintypes.BOOL
_kernel.AssignProcessToJobObject.argtypes = [ctypes.wintypes.HANDLE, ctypes.wintypes.HANDLE]
_kernel.AssignProcessToJobObject.restype = ctypes.wintypes.BOOL
_kernel.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
_kernel.CloseHandle.restype = ctypes.wintypes.BOOL


def create_kill_on_close_job() -> Any:
    handle = _kernel.CreateJobObjectW(None, None)
    if not handle:
        raise OSError(f"CreateJobObjectW failed: {ctypes.get_last_error()}")
    limits = _ExtendedLimitInformation()
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not _kernel.SetInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        ctypes.byref(limits),
        ctypes.sizeof(limits),
    ):
        error = ctypes.get_last_error()
        _kernel.CloseHandle(handle)
        raise OSError(f"SetInformationJobObject failed: {error}")
    return handle


def assign_process(job_handle: Any, process_handle: Any) -> None:
    if not _kernel.AssignProcessToJobObject(job_handle, process_handle):
        raise OSError(f"AssignProcessToJobObject failed: {ctypes.get_last_error()}")


def close_job(job_handle: Any) -> None:
    if job_handle:
        _kernel.CloseHandle(job_handle)
