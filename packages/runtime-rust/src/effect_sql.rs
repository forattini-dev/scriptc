// effect/unstable/sql, natively: a SqlClient over the program's Connection record (effect 4.0.0-beta.83's
// SqlClient.make and Statement semantics). The generated invoke adapter calls the record's execute / executeRaw /
// executeValues / executeUnprepared closures; the kernel reproduces the connection choice (the transaction
// connection in context, else the acquirer), scoped statement execution, and the transaction protocol.

/// Which connection method a statement runs.
#[derive(Clone, Copy)]
pub enum SqlOp {
    Execute,
    Raw,
    Values,
    Unprepared,
}

/// The generated bridge to the program's Connection record: (connection, method, sql, params) → the method's effect.
/// `None` params are the empty parameter list.
pub type SqlInvoke = Rc<dyn Fn(&EffectValue, SqlOp, &JsString, Option<EffectValue>) -> JsEffect>;

pub struct SqlClientData {
    acquirer: JsEffect,
    transaction_acquirer: JsEffect,
    transaction_key: JsString,
    invoke: SqlInvoke,
}

pub struct SqlStatementData {
    client: Rc<SqlClientData>,
    sql: JsString,
    params: EffectValue,
}

/// The value a transaction provides under the client's transaction key: the connection and the nesting depth.
struct SqlTransaction {
    connection: EffectValue,
    depth: f64,
}

thread_local! {
    static SQL_CLIENT_IDS: Cell<u64> = const { Cell::new(0) };
}

fn sql_no_trace() -> TraceFn {
    Box::new(|_: &mut Tracer<'_>| {})
}

/// `SqlClient.make(options)`: an effect answering a fresh client (its own transaction key, as effect numbers them).
pub fn effect_sql_client_make(acquirer: JsEffect, transaction_acquirer: JsEffect, invoke: SqlInvoke) -> JsEffect {
    let keep = (acquirer.clone(), transaction_acquirer.clone());
    effect_sync(
        Rc::new(move || {
            let id = SQL_CLIENT_IDS.with(|ids| {
                let id = ids.get();
                ids.set(id + 1);
                id
            });
            let data = SqlClientData {
                acquirer: acquirer.clone(),
                transaction_acquirer: transaction_acquirer.clone(),
                transaction_key: string(&format!("effect/sql/SqlClient/TransactionConnection/{id}")),
                invoke: invoke.clone(),
            };
            effect_box(effect_new(EffectNode::Data(KernelData::SqlClient(Rc::new(data)))))
        }),
        Box::new(move |tracer: &mut Tracer<'_>| {
            tracer.edge(&keep.0);
            tracer.edge(&keep.1);
        }),
    )
}

fn sql_client_of(handle: &JsEffect) -> Rc<SqlClientData> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::SqlClient(client)) => client.clone(),
        _ => throw_error("scriptc: a SqlClient was expected".to_owned()),
    })
}

fn sql_statement_of(handle: &JsEffect) -> Rc<SqlStatementData> {
    handle.with(|data| match &data.node {
        EffectNode::Data(KernelData::SqlStatement(statement)) => statement.clone(),
        _ => throw_error("scriptc: a SQL statement was expected".to_owned()),
    })
}

fn sql_transaction(context: &JsEffect, client: &SqlClientData) -> Option<Rc<SqlTransaction>> {
    context_lookup(&effect_context_data(context).env, &client.transaction_key)
        .and_then(|value| value.downcast_ref::<Rc<SqlTransaction>>().cloned())
}

/// The connection a statement uses: the transaction's, when one is in context, else a fresh acquisition.
fn sql_connection(client: &Rc<SqlClientData>) -> JsEffect {
    let keep = client.acquirer.clone();
    let client = client.clone();
    effect_with_fiber(
        Rc::new(move |context| match sql_transaction(&context, &client) {
            Some(transaction) => effect_succeed(transaction.connection.clone()),
            None => client.acquirer.clone(),
        }),
        Box::new(move |tracer: &mut Tracer<'_>| tracer.edge(&keep)),
    )
}

/// `client.unsafe(sql, params)`.
pub fn effect_sql_client_unsafe(client: &JsEffect, sql: &JsString, params: EffectValue) -> JsEffect {
    let data = SqlStatementData { client: sql_client_of(client), sql: sql.clone(), params };
    effect_new(EffectNode::Data(KernelData::SqlStatement(Rc::new(data))))
}

/// A statement's execution: acquire (or reuse the transaction's) connection within a scope and run the method.
pub fn effect_sql_statement_run(statement: &JsEffect, op: SqlOp) -> JsEffect {
    let data = sql_statement_of(statement);
    let connection = sql_connection(&data.client);
    let run = Rc::new(move |connection: EffectValue| (data.client.invoke)(&connection, op, &data.sql, Some(data.params.clone())));
    effect_scoped(&effect_flat_map(&connection, run, sql_no_trace()))
}

fn sql_command(client: &SqlClientData, connection: &EffectValue, sql: &str) -> JsEffect {
    (client.invoke)(connection, SqlOp::Unprepared, &string(sql), None)
}

/// The body with the transaction connection in context, then COMMIT (top level) / nothing (nested) on success and
/// ROLLBACK / ROLLBACK TO SAVEPOINT on failure; the body's exit is the result.
fn sql_in_transaction(client: &Rc<SqlClientData>, connection: EffectValue, depth: f64, body: &JsEffect) -> JsEffect {
    let entry: EffectValue = effect_box(Rc::new(SqlTransaction { connection: connection.clone(), depth }));
    let provided = effect_new(EffectNode::ProvideBundle(body.clone(), Rc::new(vec![(client.transaction_key.clone(), entry)])));
    let client = client.clone();
    effect_flat_map(
        &effect_exit(&provided),
        Rc::new(move |exit_value: EffectValue| {
            let exit = effect_unbox::<JsEffect>(&exit_value);
            let finish = if effect_exit_is_success(&exit) {
                (depth == 0.0).then(|| effect_or_die(&sql_command(&client, &connection, "COMMIT")))
            } else if depth > 0.0 {
                Some(effect_or_die(&sql_command(&client, &connection, &format!("ROLLBACK TO SAVEPOINT effect_sql_{depth}"))))
            } else {
                Some(effect_or_die(&sql_command(&client, &connection, "ROLLBACK")))
            };
            match finish {
                Some(finish) => effect_zip_right(&finish, &exit),
                None => exit,
            }
        }),
        sql_no_trace(),
    )
}

/// `client.withTransaction(effect)`: a top-level transaction acquires a connection in its own scope and BEGINs; a
/// nested one takes a SAVEPOINT on the transaction's connection.
pub fn effect_sql_client_with_transaction(client: &JsEffect, body: &JsEffect) -> JsEffect {
    let client = sql_client_of(client);
    let body = body.clone();
    let keep = body.clone();
    effect_with_fiber(
        Rc::new(move |context| match sql_transaction(&context, &client) {
            Some(transaction) => {
                let depth = transaction.depth + 1.0;
                let savepoint = sql_command(&client, &transaction.connection, &format!("SAVEPOINT effect_sql_{depth}"));
                effect_zip_right(&savepoint, &sql_in_transaction(&client, transaction.connection.clone(), depth, &body))
            }
            None => {
                let acquirer = client.transaction_acquirer.clone();
                let client = client.clone();
                let body = body.clone();
                let begin = Rc::new(move |connection: EffectValue| {
                    let started = sql_command(&client, &connection, "BEGIN");
                    effect_zip_right(&started, &sql_in_transaction(&client, connection, 0.0, &body))
                });
                effect_scoped(&effect_flat_map(&acquirer, begin, sql_no_trace()))
            }
        }),
        Box::new(move |tracer: &mut Tracer<'_>| tracer.edge(&keep)),
    )
}

/// `client.transactionService`.
pub fn effect_sql_client_transaction_key(client: &JsEffect) -> JsEffect {
    effect_service_key(&sql_client_of(client).transaction_key)
}

/// `client.reserve`: the transaction acquirer.
pub fn effect_sql_client_reserve(client: &JsEffect) -> JsEffect {
    sql_client_of(client).transaction_acquirer.clone()
}

/// `SqlClient.SafeIntegers`: a reference defaulting to false.
pub fn effect_sql_safe_integers_key() -> JsEffect {
    effect_reference_key(&string("effect/sql/SqlClient/SafeIntegers"), Rc::new(|| effect_box(false)))
}
