// The one part of the log stack that can do real harm: a frame can carry a live
// credential, and a log line outlives whatever it was minted for.
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/logging/redact.dart';

void main() {
  test('a key nested inside a frame payload never reaches the log', () {
    final payload = {
      'engine': 'codex',
      'cwd': '/Users/dev/code/autonomous-battle',
      'endpoint': {
        'baseUrl': 'https://llm.example.test/v1',
        'apiKey': 'sk-live-THIS-MUST-NOT-BE-LOGGED',
        'model': 'DeepSeek-V4-Flash-0731',
      },
    };

    final line = summariseForLog(payload);

    expect(line, isNot(contains('THIS-MUST-NOT-BE-LOGGED')));
    expect(line, contains('<redacted>'));
    // The fields that make the line worth writing survive.
    expect(line, contains('codex'));
    expect(line, contains('DeepSeek-V4-Flash-0731'));
    expect(line, contains('llm.example.test'));
  });

  test('a secret is caught wherever it is nested', () {
    for (final key in const [
      'apiKey',
      'api_key',
      'token',
      'authToken',
      'Authorization',
      'sessionToken',
      'password',
      'secret',
    ]) {
      final line = redactValue({
        'a': {
          'b': {key: 'leaked'},
        },
      });
      expect(line, isNot(contains('leaked')), reason: key);
      expect(line, contains('<redacted>'), reason: key);
    }
  });

  test('a long value is clipped rather than burying the fields beside it', () {
    final line = redactValue({'blob': 'x' * 500, 'after': 'visible'});
    expect(line, contains('…'));
    expect(line, contains('after: visible'));
    expect(line.length, lessThan(300));
  });

  test('a list is counted, not printed', () {
    expect(
      redactValue({'agents': List.filled(40, 'a')}),
      '{agents: [40 items]}',
    );
    expect(
      redactValue({
        'agents': ['a'],
      }),
      '{agents: [1 item]}',
    );
  });

  test('the whole line is capped', () {
    final wide = {for (var i = 0; i < 400; i++) 'field$i': 'value$i'};
    expect(summariseForLog(wide).length, lessThanOrEqualTo(1201));
  });

  test('a whole agent_create reply survives the cap', () {
    // The cap exists to bound a runaway line, not to cut off the field somebody
    // is reading it for — and the LAST field in an Agent is the first thing a
    // tighter cap would eat.
    final reply = {
      'agent': {
        'id': 'agt_01HXYZ0123456789',
        'name': 'autonomous-battle',
        'engine': 'codex',
        'engineDisplayName': 'OpenAI Codex',
        'sessionId': 'harness-agt-01hxyz',
        'status': 'running',
        'cwd': '/Users/dev/code/autonomous-battle',
        'terminalAvailable': true,
        'parentAgentId': null,
        'codexHome': '/Users/dev/.codex-work',
      },
    };

    expect(summariseForLog(reply), contains('/Users/dev/.codex-work'));
  });

  group('free-form CLI output, which has no keys to go by', () {
    test('a session token printed by the CLI is blanked', () {
      const line =
          '{"session_token": "sess-live-abcdef123456", "email": "dev@x.ai"}';

      final redacted = redactSecretsInText(line);

      expect(redacted, isNot(contains('sess-live-abcdef123456')));
      expect(redacted, contains('<redacted>'));
      // What makes the line worth keeping survives.
      expect(redacted, contains('dev@x.ai'));
    });

    test('a bearer header and a vendor key are both caught', () {
      expect(
        redactSecretsInText('Authorization: Bearer abcdef1234567890'),
        isNot(contains('abcdef1234567890')),
      );
      expect(
        redactSecretsInText('using sk-ant-api03-not-a-real-key'),
        'using sk-<redacted>',
      );
    });

    test('a key in a URL query is caught', () {
      final redacted = redactSecretsInText(
        'GET https://api.example.test/v1/usage?api_key=abc123def456',
      );

      expect(redacted, isNot(contains('abc123def456')));
      expect(redacted, contains('api.example.test/v1/usage'));
    });

    test('ordinary output is left exactly as it was', () {
      const line = 'harness 1.4.2 — 3 machines, 2 agents running';
      expect(redactSecretsInText(line), line);
    });
  });
}
