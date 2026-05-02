import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.table("user", (table) => {
        table.string("twofa_method", 20).defaultTo("totp");
        table.text("twofa_recovery_codes").nullable();
        table.integer("twofa_failed_attempts").notNullable().defaultTo(0);
        table.datetime("twofa_locked_until").nullable();
        table.datetime("twofa_secret_set_at").nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.table("user", (table) => {
        table.dropColumn("twofa_method");
        table.dropColumn("twofa_recovery_codes");
        table.dropColumn("twofa_failed_attempts");
        table.dropColumn("twofa_locked_until");
        table.dropColumn("twofa_secret_set_at");
    });
}
