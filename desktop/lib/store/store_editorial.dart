import '../core/dsh_catalog.dart';

/// Broad browsing sections; packages keep their own precise domain labels.
const storeCategoryDomains = <String, Set<String>>{
  'Design': {'3D', 'CAD', 'Diagrams'},
  'Engineering': {'PCB', 'Circuits', 'Chips'},
  'Media': {'Documents', 'Slides', 'Video', 'Math animation', 'Music'},
  'Science': {'Chemistry', 'Notebooks', 'Simulation'},
  'Games': {'Games'},
  'Code': {'Code'},
};

String storeCategoryFor(DshEntry entry) {
  if (entry.isEngine) return 'Code';
  final domain = entry.category?.trim().toLowerCase();
  for (final category in storeCategoryDomains.entries) {
    if (category.key.toLowerCase() == domain ||
        category.value.any((value) => value.toLowerCase() == domain)) {
      return category.key;
    }
  }
  // A community package in a new domain stays browsable without adding an
  // ever-growing list of individual domains to the sidebar.
  return 'Other';
}

/// Editorial copy is separate from registry identity and installation facts.
/// A feature only appears when its package is in the machine's live catalog.
class StoreStory {
  const StoreStory({
    required this.benefit,
    required this.prompts,
    this.headline,
    this.description,
    this.asset,
    this.caption,
  });

  final String benefit;
  final List<String> prompts;
  final String? headline;
  final String? description;
  final String? asset;
  final String? caption;
}

const _pcb = StoreStory(
  benefit: 'Turn an idea into a circuit board.',
  headline: 'That board in your head?\nMake it real.',
  description: 'Design circuits, lay out a board, and inspect it in 3D.',
  asset: 'assets/store/copper-board.png',
  caption: 'Terminal keyboard · Copper example board',
  prompts: [
    'Design a six-key USB macropad. Start with the schematic.',
    'Walk me through the components on this board and what they do.',
  ],
);

const storeStories = <String, StoreStory>{
  'autonomous/blender': StoreStory(
    benefit: 'Your imagination, in three dimensions.',
    headline: 'You can\ndesign in 3D.',
    description: 'Describe a scene. Shape every detail.\nMake something you never thought you could.',
    asset: 'assets/store/blender-studio.png',
    caption: 'A scene made with Blender · Original Harness artwork',
    prompts: [
      'Create a sculptural scene with an orange arch, a chrome sphere, and soft studio lighting.',
      'Design a ceramic mug with a rounded handle. Show me a turntable view.',
    ],
  ),
  'autonomous/copper': _pcb,
  'autonomous/autonomous-circuit': _pcb,
  'autonomous/text-to-cad': StoreStory(
    benefit: 'Describe a part. Make it yours.',
    prompts: [
      'Design a phone stand with an adjustable viewing angle.',
      'Make a small enclosure for my circuit board, with mounting holes.',
    ],
  ),
  'autonomous/autonomous-workshop': StoreStory(
    benefit: 'Create parts you can hold in your hand.',
    prompts: ['Design a desk cable organizer with three channels.'],
  ),
  'autonomous/phaser': StoreStory(
    benefit: 'Make the game you want to play.',
    headline: 'Your rules.\nYour game.',
    description: 'Build a world, invent the rules, and press play.',
    asset: 'assets/store/phaser-bricks.png',
    caption: 'Bricks · The playable Phaser starter',
    prompts: [
      'Build a colorful brick-breaker game with power-ups and a high score.',
      'Make a tiny platformer where a robot collects stars.',
    ],
  ),
  'autonomous/strudel': StoreStory(
    benefit: 'Find your sound. Make it play.',
    prompts: ['Make a warm lo-fi beat with soft keys and a rolling bassline.'],
  ),
  'autonomous/mujoco': StoreStory(
    benefit: 'Give your robot a world to explore.',
    prompts: ['Build a pendulum simulation and show its energy over time.'],
  ),
  'autonomous/manim': StoreStory(
    benefit: 'Make a hard idea suddenly click.',
    prompts: [
      'Animate why the area of a circle is pi times its radius squared.',
    ],
  ),
  'autonomous/marp': StoreStory(
    benefit: 'Turn your story into a beautiful deck.',
    prompts: ['Create a five-slide pitch for a neighborhood repair café.'],
  ),
  'autonomous/remotion': StoreStory(
    benefit: 'Turn a story into a moving picture.',
    prompts: [
      'Make a 15-second product launch video with animated typography.',
    ],
  ),
  'autonomous/excalidraw': StoreStory(
    benefit: 'Give your thinking a clear picture.',
    prompts: ['Draw a simple architecture diagram for a multiplayer game.'],
  ),
  'autonomous/marimo': StoreStory(
    benefit: 'Find the story hiding in your data.',
    prompts: [
      'Explore this CSV with interactive charts and explain the patterns.',
    ],
  ),
  'autonomous/typst': StoreStory(
    benefit: 'Make documents worth reading.',
    prompts: ['Create a clean, beautifully typeset two-page project proposal.'],
  ),
  'autonomous/circuitjs': StoreStory(
    benefit: 'See how your circuit really works.',
    prompts: ['Build a 555 timer circuit and show me why the LED blinks.'],
  ),
  'autonomous/rdkit': StoreStory(
    benefit: 'Explore the world of molecules.',
    prompts: [
      'Compare the structures and properties of caffeine and theobromine.',
    ],
  ),
  'autonomous/yosys': StoreStory(
    benefit: 'Build logic. See it become a chip.',
    prompts: ['Design a four-bit counter and show its simulated waveform.'],
  ),
};

class StoreCollection {
  const StoreCollection({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.categories,
    required this.featuredIds,
  });

  final String id;
  final String title;
  final String subtitle;
  final Set<String> categories;
  final List<String> featuredIds;

  bool includes(DshEntry entry) =>
      !entry.isEngine &&
      !entry.isViewerPackage &&
      (categories.contains(entry.category) || featuredIds.contains(entry.id));
}

const storeCollections = [
  StoreCollection(
    id: 'shape',
    title: 'Give your ideas shape.',
    subtitle: '3D scenes. Custom parts. Your design.',
    categories: {'3D', 'CAD'},
    featuredIds: ['autonomous/blender', 'autonomous/text-to-cad'],
  ),
  StoreCollection(
    id: 'hardware',
    title: 'Build something real.',
    subtitle: 'From your first circuit to your own board.',
    categories: {'PCB', 'Circuits', 'Chips'},
    featuredIds: [
      'autonomous/copper',
      'autonomous/autonomous-circuit',
      'autonomous/circuitjs',
    ],
  ),
  StoreCollection(
    id: 'play',
    title: 'Make something play.',
    subtitle: 'Invent a game. Find a sound. Set it in motion.',
    categories: {'Games', 'Music', 'Simulation'},
    featuredIds: [
      'autonomous/phaser',
      'autonomous/strudel',
      'autonomous/mujoco',
    ],
  ),
];

String storeBenefit(DshEntry entry) =>
    storeStories[entry.id]?.benefit ??
    entry.description ??
    entry.category ??
    '';

bool storeMatches(DshEntry entry, String query) {
  final terms = query.trim().toLowerCase().split(RegExp(r'\s+'));
  final text = [
    entry.name,
    entry.id,
    entry.author,
    entry.category,
    storeCategoryFor(entry),
    entry.description,
    storeBenefit(entry),
  ].join(' ').toLowerCase();
  return terms.every(text.contains);
}
