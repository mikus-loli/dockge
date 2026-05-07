import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    if (!(await knex.schema.hasTable("update_log"))) {
        await knex.schema.createTable("update_log", (table) => {
            table.increments("id");
            table.string("image_name", 500).notNullable();
            table.string("target_type", 20).notNullable().defaultTo("dockge");
            table.string("target_name", 200).nullable();
            table.string("old_version", 200).nullable();
            table.string("new_version", 200).nullable();
            table.string("status", 20).notNullable();
            table.text("error_message").nullable();
            table.integer("duration_ms").nullable();
            table.string("rollback_image", 500).nullable();
            table.datetime("created_at").notNullable().defaultTo(knex.fn.now());
        });
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("update_log");
}
