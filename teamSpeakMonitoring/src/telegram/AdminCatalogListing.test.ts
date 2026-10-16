import test from "node:test";
import assert from "node:assert/strict";
import {AdminCatalogListing} from "./AdminCatalogListing.js";
import {decodeAdminButton} from "./ServerAdminMessages.js";
import type {Permission} from "../access/Roles.js";

test("админский вид положен только чату с правом просмотра", async () => {
    const asked: Permission[] = [];
    const listing = new AdminCatalogListing(
        {can: async (_chatId, permission) => {
            asked.push(permission);
            return true;
        }},
        {summaries: async () => ({servers: [], total: 0})},
    );

    assert.equal(await listing.canSeeAll(42), true);
    assert.deepEqual(asked, ["ROLE_SERVER_ADMIN_VIEW"]);
});

test("значки готовности выводятся из фактов, кнопка ведёт в админскую карточку", async () => {
    const listing = new AdminCatalogListing({can: async () => true}, {
        summaries: async () => ({
            total: 2,
            servers: [
                {id: 1, name: "Draft", gameAddress: "a:1", enabled: false, listPosition: undefined, enabledSourceCount: 0, enabledPrimaryCount: 0},
                {id: 2, name: "Ready", gameAddress: "b:2", enabled: true, listPosition: undefined, enabledSourceCount: 1, enabledPrimaryCount: 1},
            ],
        }),
    });
    const page = await listing.page("", 8, 0);

    assert.deepEqual(page.servers, [{id: 1, name: "Draft", gameAddress: "a:1"}, {id: 2, name: "Ready", gameAddress: "b:2"}]);
    assert.deepEqual([...page.marks], [[1, "📝"], [2, "🟢"]]);
    assert.deepEqual(decodeAdminButton(listing.openButton(2, {view: "catalog", page: 1, search: "x"})), {
        action: "open",
        id: 2,
        origin: {view: "catalog", page: 1, search: "x"},
    });
});

test("закреплённый сервер помечен в админском списке", async () => {
    const listing = new AdminCatalogListing({can: async () => true}, {
        summaries: async () => ({
            total: 1,
            servers: [{id: 3, name: "Top", gameAddress: "c:3", enabled: true, listPosition: 1, enabledSourceCount: 1, enabledPrimaryCount: 1}],
        }),
    });

    assert.equal((await listing.page("", 8, 0)).marks.get(3), "🟢📌");
});
