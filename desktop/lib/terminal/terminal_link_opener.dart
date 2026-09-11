import 'dart:io';

import 'package:url_launcher/url_launcher.dart';

import 'terminal_links.dart';
import 'remote_media_download.dart';

/// Uses the existing OS launcher, never a shell command built from agent text.
class TerminalLinkOpener {
  TerminalLinkOpener({
    Future<bool> Function(Uri)? launch,
    Future<bool> Function(String)? fileExists,
    String? homeDirectory,
    bool? windows,
  }) : _launch = launch ?? _launchExternal,
       _fileExists = fileExists ?? _exists,
       _homeDirectory =
           homeDirectory ??
           Platform.environment['HOME'] ??
           Platform.environment['USERPROFILE'],
       _windows = windows ?? Platform.isWindows;

  final Future<bool> Function(Uri) _launch;
  final Future<bool> Function(String) _fileExists;
  final String? _homeDirectory;
  final bool _windows;

  static Future<bool> _launchExternal(Uri uri) =>
      launchUrl(uri, mode: LaunchMode.externalApplication);
  static Future<bool> _exists(String path) => File(path).exists();

  /// Null means the OS accepted the request; otherwise a user-facing failure.
  Future<String?> open(
    String target, {
    required bool isLocalMachine,
    Future<String> Function(String target)? downloadRemote,
    bool Function()? isCancelled,
  }) async {
    if (RegExp(r'[\x00-\x1f\x7f]').hasMatch(target)) {
      return 'This link is not supported.';
    }
    try {
      final parsed = Uri.tryParse(target);
      if (parsed == null) return 'This link is not supported.';
      Uri uri;
      if (parsed.scheme == 'https' || parsed.scheme == 'http') {
        if (parsed.host.isEmpty) return 'This link is not supported.';
        uri = parsed;
      } else {
        if (!isLocalMachine) {
          if (parsed.scheme == 'file' &&
              parsed.host.isNotEmpty &&
              parsed.host != 'localhost') {
            return 'This file is on another machine.';
          }
          if (parsed.hasScheme &&
              parsed.scheme != 'file' &&
              !RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(target)) {
            return 'This link is not supported.';
          }
          if (!isMediaPath(parsed.scheme == 'file' ? parsed.path : target)) {
            return 'Only image and video files can be opened here.';
          }
          if (downloadRemote == null) {
            return 'This file is on another machine. Update Harness to download a preview.';
          }
          // Resolve paths on the owning machine; open only the completed local copy.
          final localPath = await downloadRemote(target);
          if (isCancelled?.call() == true) return null;
          if (!await _fileExists(localPath)) {
            return 'The downloaded preview is no longer available. Try again.';
          }
          uri = Uri.file(localPath, windows: _windows);
        } else {
          var path = target;
          if (parsed.scheme == 'file') {
            if (parsed.host.isNotEmpty && parsed.host != 'localhost') {
              return 'This file is on another machine.';
            }
            path = parsed
                .replace(host: '', query: '', fragment: '')
                .toFilePath(windows: _windows);
          } else if (parsed.hasScheme &&
              !RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(path)) {
            return 'This link is not supported.';
          }
          if (path.startsWith('~/') && _homeDirectory != null) {
            path = '$_homeDirectory/${path.substring(2)}';
          }
          if (!isMediaPath(path)) {
            return 'Only image and video files can be opened here.';
          }
          final absolute = _windows
              ? RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(path)
              : path.startsWith('/') && !path.startsWith('//');
          if (!absolute) {
            // Agent frames do not advertise cwd. Never resolve against Desktop's
            // process directory, which belongs to a different app and workspace.
            return 'Use the full file path to open this preview. The agent’s working folder is not available.';
          }
          if (!await _fileExists(path)) {
            return 'This file is not available on this computer. It may still be generating or may have moved.';
          }
          uri = Uri.file(path, windows: _windows);
        }
      }
      if (isCancelled?.call() == true) return null;
      if (!await _launch(uri)) {
        return 'Could not open this preview. Check that a default app is installed.';
      }
      return null;
    } on RemoteMediaCancelled {
      return null;
    } on RemoteMediaException catch (error) {
      return error.message;
    } catch (_) {
      return 'Could not open this preview. Check that the file is accessible and a default app is installed.';
    }
  }
}
