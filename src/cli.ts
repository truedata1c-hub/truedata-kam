// Администрирование стенда из командной строки:
//   migrate
//   create-client <code> <name>               (создаёт клиента с ролью «Администратор»)
//   create-user <email> <display name>        (пароль из KAM_PASSWORD)
//   grant-admin <email> <client code>         (членство и роль «Администратор»)
//   set-password <email>                      (новый пароль из KAM_PASSWORD; сессии сбрасываются)
//   disable-user <email> | enable-user <email>
//   seed-demo [--reset]                       (демо-набор; пароль демо-пользователей из KAM_PASSWORD)

import { randomUUID } from 'node:crypto';
import { createPool, migrate, type Db } from './db.js';
import { createUser, hashPassword } from './auth.js';
import { seedDemo } from './demo.js';

async function adminRole(db: Db, clientId: string): Promise<string> {
  const found = (await db.query<{ id: string }>("select id from kam.business_role where client_id=$1 and not archived and 'ADMIN' = any(permissions) order by created_at limit 1", [clientId])).rows[0];
  if (found) return found.id;
  const id = randomUUID();
  await db.query("insert into kam.business_role(client_id, id, name, description, permissions, scope) values ($1,$2,'Администратор','Пользователи, роли, справочники и маршруты.',$3,'ALL')",
    [clientId, id, ['ADMIN']]);
  return id;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createPool(url);
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await migrate(db);
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
        break;
      }
      case 'create-client': {
        const [code, ...name] = args;
        if (!code || !name.length) throw new Error('usage: create-client <code> <name>');
        const id = randomUUID();
        await db.query('insert into kam.client(id, code, name) values ($1,$2,$3)', [id, code, name.join(' ')]);
        await adminRole(db, id);
        console.log(id);
        break;
      }
      case 'create-user': {
        const [email, ...name] = args;
        const password = process.env.KAM_PASSWORD;
        if (!email || !name.length || !password) throw new Error('usage: KAM_PASSWORD=... create-user <email> <display name>');
        console.log(await createUser(db, email, name.join(' '), password));
        break;
      }
      case 'grant-admin': {
        const [email, code] = args;
        if (!email || !code) throw new Error('usage: grant-admin <email> <client code>');
        const u = (await db.query<{ id: string }>('select id from kam.app_user where email=$1', [email.toLowerCase()])).rows[0];
        const c = (await db.query<{ id: string }>('select id from kam.client where code=$1', [code])).rows[0];
        if (!u || !c) throw new Error('user or client not found');
        await db.query('insert into kam.membership(client_id, user_id) values ($1,$2) on conflict (client_id, user_id) do update set active=true', [c.id, u.id]);
        await db.query('insert into kam.user_business_role(client_id, user_id, role_id) values ($1,$2,$3) on conflict do nothing', [c.id, u.id, await adminRole(db, c.id)]);
        console.log('ok');
        break;
      }
      case 'set-password': {
        const [email] = args;
        const password = process.env.KAM_PASSWORD;
        if (!email || !password) throw new Error('usage: KAM_PASSWORD=... set-password <email>');
        const r = await db.query('update kam.app_user set password_hash=$2, must_change_password=false where email=$1 returning id', [email.toLowerCase(), await hashPassword(password)]);
        if (!r.rowCount) throw new Error('user not found');
        await db.query('delete from kam.session where user_id=$1', [r.rows[0].id]);
        console.log('ok');
        break;
      }
      case 'disable-user':
      case 'enable-user': {
        const [email] = args;
        if (!email) throw new Error(`usage: ${cmd} <email>`);
        const r = await db.query('update kam.app_user set disabled=$2 where email=$1 returning id', [email.toLowerCase(), cmd === 'disable-user']);
        if (!r.rowCount) throw new Error('user not found');
        if (cmd === 'disable-user') await db.query('delete from kam.session where user_id=$1', [r.rows[0].id]);
        console.log('ok');
        break;
      }
      case 'seed-demo': {
        const password = process.env.KAM_PASSWORD;
        if (!password) throw new Error('usage: KAM_PASSWORD=... seed-demo [--reset]');
        const r = await seedDemo(db, { password, reset: args.includes('--reset'), domain: process.env.DEMO_EMAIL_DOMAIN });
        console.log(`demo client ${r.clientId}: ${r.users} users, ${r.campaigns} campaigns`);
        break;
      }
      default:
        throw new Error('unknown command; see header of src/cli.ts');
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
