import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    const hasTable = await knex.schema.hasTable("update_log");
    if (hasTable) {
        await knex.schema.dropTable("update_log");
    }
    return knex.schema.createTable("update_log", (table) => {
        table.increments("id");
        table.string("stackName", 200).notNullable();
        table.string("type", 20).notNullable();
        table.string("status", 20).notNullable();
        table.text("message").notNullable();
        table.text("oldDigest");
        table.text("newDigest");
        table.string("timestamp", 50).notNullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.dropTable("update_log");
}
