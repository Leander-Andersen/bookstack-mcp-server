import { redactArgs } from '../../src/utils/redact';

describe('redactArgs', () => {
  it('redacts passwords, page content and upload payloads but keeps ids', () => {
    const out: any = redactArgs({
      id: 4,
      name: 'Doc',
      password: 'hunter2hunter2',
      html: '<p>secret page</p>',
      markdown: '# secret',
      image: 'AAAA',
      email: 'a@example.com',
    });
    expect(out.id).toBe(4);
    expect(out.name).toBe('Doc');
    expect(out.password).toBe('[redacted 14 chars]');
    expect(out.html).toBe('[redacted 18 chars]');
    expect(out.markdown).toBe('[redacted 8 chars]');
    expect(out.image).toBe('[redacted 4 chars]');
    expect(out.email).toBe('[redacted 13 chars]');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('secret page');
  });

  it('redacts inside arrays and nested objects (edit fragments, filters)', () => {
    const out = JSON.stringify(
      redactArgs({
        edits: [{ old_string: 'old private text', new_string: 'new private text' }],
        filter: { email: 'a@example.com', name: 'x' },
      })
    );
    expect(out).not.toContain('private text');
    expect(out).not.toContain('a@example.com');
    expect(out).toContain('"name":"x"');
  });
});
