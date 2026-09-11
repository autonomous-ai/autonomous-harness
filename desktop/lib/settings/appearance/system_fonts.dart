import '../../shared/widgets/app_select_field.dart';

/// The faces the app's UI can be set in.
///
/// ⚠️ A curated list, not the machine's installed fonts — for now. Enumerating
/// what is installed needs a native `MethodChannel`, and this ships without one
/// on purpose: the platform side is the part that a headless `flutter test`
/// cannot verify (the test font manager resolves every family to one face and
/// reports monospace metrics for all of them), so a channel written now would be
/// a feature nobody could prove works until it was already in front of a user.
///
/// The cost is stated plainly rather than hidden: someone whose favourite face
/// is installed but not listed cannot pick it yet.
///
/// [load] is async and returns a future today for no reason other than this: the
/// day the channel lands, only the body of this function changes, and no widget
/// that awaits it has to be rewritten.
abstract final class SystemFonts {
  /// `null` is the system font. It is FIRST because it is the default and the
  /// answer most people want, and it is spelled with a note rather than with its
  /// real name — `.AppleSystemUIFont` is a private CoreText name, correct to
  /// resolve against and wrong to show a person.
  static const List<SelectOption<String?>> _uiFamilies = [
    SelectOption(value: null, label: 'System', note: 'SF Pro'),
    SelectOption(value: 'Helvetica Neue', label: 'Helvetica Neue'),
    SelectOption(value: 'Avenir Next', label: 'Avenir Next'),
    SelectOption(value: 'Optima', label: 'Optima'),
    SelectOption(value: 'Georgia', label: 'Georgia'),
    SelectOption(value: 'Menlo', label: 'Menlo'),
  ];

  /// The list to show, given what is currently chosen.
  ///
  /// ⚠️ A saved family that is not in the list is ADDED rather than dropped,
  /// carrying a note. A picker that silently forgets the user's setting — and
  /// then shows a different font as if it were the choice — is a worse failure
  /// than an entry that explains itself. This is also what will keep a setting
  /// alive across a machine where the face is genuinely missing.
  static Future<List<SelectOption<String?>>> load({String? selected}) async {
    if (selected == null || _uiFamilies.any((o) => o.value == selected)) {
      return _uiFamilies;
    }
    return [
      ..._uiFamilies,
      SelectOption(
        value: selected,
        label: selected,
        note: 'not in the list on this Mac',
      ),
    ];
  }
}
