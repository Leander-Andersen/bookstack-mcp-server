import { UserTools } from '../../src/tools/users';
import { RoleTools } from '../../src/tools/roles';

const logger: any = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const validator: any = { validateParams: jest.fn((p: any) => p), validateId: jest.fn((i: any) => Number(i)) };

function tool(tools: any[], name: string) {
  return tools.find((t) => t.name === name)!;
}

describe('users tools', () => {
  const client: any = { deleteUser: jest.fn().mockResolvedValue(undefined) };
  const tools = new UserTools(client, validator, logger).getTools();

  it('does not advertise a nonexistent `active` field', () => {
    const update = tool(tools, 'bookstack_users_update');
    expect(update.inputSchema.properties.active).toBeUndefined();
    const list = tool(tools, 'bookstack_users_list');
    expect(list.inputSchema.properties.filter.properties.active).toBeUndefined();
  });

  it('refuses to name the deleted user as their own heir', async () => {
    const del = tool(tools, 'bookstack_users_delete');
    await expect(del.handler({ id: 5, migrate_ownership_id: 5 })).rejects.toThrow(/different user/);
    expect(client.deleteUser).not.toHaveBeenCalled();
    await del.handler({ id: 5, migrate_ownership_id: 1 });
    expect(client.deleteUser).toHaveBeenCalledWith(5, 1);
  });
});

describe('roles tools', () => {
  const client: any = { deleteRole: jest.fn().mockResolvedValue(undefined) };
  const tools = new RoleTools(client, validator, logger).getTools();

  it('does not advertise migrate_ownership_id on roles_delete', async () => {
    const del = tool(tools, 'bookstack_roles_delete');
    expect(del.inputSchema.properties.migrate_ownership_id).toBeUndefined();
    await del.handler({ id: 3, migrate_ownership_id: 2 });
    expect(client.deleteRole).toHaveBeenCalledWith(3);
  });
});
