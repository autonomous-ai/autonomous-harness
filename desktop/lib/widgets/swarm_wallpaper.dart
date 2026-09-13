import 'dart:async';

import 'package:flutter/material.dart';

import '../state/swarm.dart';

/// Wallpaper belongs only to the empty new-swarm canvas.
class SwarmWallpaper extends StatefulWidget {
  const SwarmWallpaper({super.key, required this.index});

  final int index;

  @override
  State<SwarmWallpaper> createState() => _SwarmWallpaperState();
}

class _SwarmWallpaperState extends State<SwarmWallpaper> {
  late AssetImage _image = _wallpaper(widget.index);
  ImageConfiguration _configuration = ImageConfiguration.empty;

  static AssetImage _wallpaper(int index) => AssetImage(
    'assets/swarm-wallpapers/swarm-welcome-${swarmWallpapers[index % swarmWallpapers.length]}.jpg',
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _configuration = createLocalImageConfiguration(context);
  }

  @override
  void didUpdateWidget(SwarmWallpaper oldWidget) {
    super.didUpdateWidget(oldWidget);
    final next = _wallpaper(widget.index);
    if (next == _image) return;
    unawaited(_image.evict(configuration: _configuration));
    _image = next;
  }

  @override
  void dispose() {
    // Populated swarms do not retain a decoded welcome image in Flutter's
    // keep-alive cache. Evict only our asset, leaving terminal images alone.
    unawaited(_image.evict(configuration: _configuration));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      Image(
        image: _image,
        fit: BoxFit.cover,
        gaplessPlayback: true,
        excludeFromSemantics: true,
      ),
      const DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0x1211111c), Color(0x750c111e)],
          ),
        ),
      ),
    ],
  );
}
