import test from "node:test";
import assert from "node:assert/strict"
import {createPool, type Pool} from "mariadb";
import {dbConfig} from "../properties.js";
import {insertMonitoredServerFixture, migrateTestDatabase, truncateTestDatabase} from "../test/databaseTestUtils.js";
import {ServerRepository} from "./ServerRepository.js";

let pool: Pool;
let repository: ServerRepository;

test.before(async () => {
    pool = createPool(dbConfig)
    repository = new ServerRepository(pool);

    await migrateTestDatabase(pool);
    await truncateTestDatabase(pool);

    await insertMonitoredServerFixture(pool, {
        name: "Test server enabled",
        gameAddress: "127.0.0.1:2001",
        query: {
            type: "a2s",
            host: "127.0.0.1",
            port: 17777,
            timeout: 1000,
        },
        enabled: true,
    });

    await insertMonitoredServerFixture(pool, {
        name: "Test server enabled",
        gameAddress: "127.0.0.1:2002",
        query: {
            type: "a2s",
            host: "127.0.0.1",
            port: 17778,
            timeout: 1000,
        },
        enabled: false,
    });

    await insertMonitoredServerFixture(pool, {
        name: "Test REST server",
        gameAddress: "https://example.com",
        query: {
            type: "rest",
            url: "https://example.com/status",
            timeout: 1000,
        },
        enabled: true,
    });

});

test("indAllEnabled returns only enabled monitored servers", async () => {
    const servers = await repository.findAllEnabled();
    const withoutId = servers.map(({id, ...server}) => server);
    assert.deepEqual(withoutId, [
        {
            name: "Test server enabled",
            gameAddress: "127.0.0.1:2001",
            query: {
                host: '127.0.0.1',
                port: 17777,
                timeout: 1000,
                type: 'a2s'
            }
        },
        {
            name: "Test REST server",
            gameAddress: "https://example.com",
            query: {
                type: "rest",
                url: "https://example.com/status",
                timeout: 1000,
            },
        }
    ])

});

test.after(async () => {
    await pool.end();
});
