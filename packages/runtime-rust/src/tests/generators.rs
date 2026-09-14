#[test]
fn generator_protocol_suspends_resumes_and_finishes_once() {
    let generator: JsGenerator<f64, f64, f64> = generator_new(|generator, command| {
        assert!(matches!(command, GeneratorCommand::Next(99.0)));
        generator_suspend(&generator, |_generator, command| match command {
            GeneratorCommand::Next(value) => GeneratorStep::Returned(Some(value)),
            GeneratorCommand::Return(value) => GeneratorStep::Returned(value),
            GeneratorCommand::Throw(reason) => rethrow_caught(reason),
        });
        GeneratorStep::Yielded(1.0)
    });

    assert!(generator_ptr_eq(&generator, &generator.clone()));
    assert!(matches!(generator_next(&generator, 99.0), GeneratorStep::Yielded(1.0)));
    assert!(matches!(generator_next(&generator, 7.0), GeneratorStep::Returned(Some(7.0))));
    assert!(matches!(generator_next(&generator, 8.0), GeneratorStep::Returned(None)));
}

#[test]
fn generator_return_closes_an_unstarted_generator_without_running_it() {
    let generator: JsGenerator<f64, f64, ()> =
        generator_new(|_, _| panic!("an unstarted generator body must not run on return"));

    assert!(matches!(generator_return(&generator, Some(5.0)), GeneratorStep::Returned(Some(5.0))));
    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Returned(None)));
}

#[test]
fn generator_throw_closes_an_unstarted_generator_and_preserves_the_reason() {
    let generator: JsGenerator<f64, f64, ()> =
        generator_new(|_, _| panic!("an unstarted generator body must not run on throw"));
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        generator_throw(&generator, caught_value(string("early")))
    }))
    .err()
    .expect("throw on an unstarted generator must propagate");
    let caught = caught_from_panic(payload);

    assert_eq!(caught_narrow::<JsString>(&caught).as_ref(), "early");
    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Returned(None)));
}

#[test]
fn generator_panic_handler_survives_suspension_and_handles_body_throws() {
    let generator: JsGenerator<f64, JsString, ()> = generator_new(|generator, _| {
        generator_push_panic_handler(&generator, |_generator, reason| {
            GeneratorStep::Returned(Some(caught_narrow::<JsString>(&reason)))
        });
        generator_suspend(&generator, |_generator, _| throw_value(string("inside")));
        GeneratorStep::Yielded(1.0)
    });

    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Yielded(1.0)));
    match generator_next(&generator, ()) {
        GeneratorStep::Returned(Some(value)) => assert_eq!(value.as_ref(), "inside"),
        _ => panic!("the parked panic handler must convert the throw into a return"),
    }
    assert!(matches!(generator_next(&generator, ()), GeneratorStep::Returned(None)));
}

#[test]
fn async_generator_queues_requests_and_settles_them_in_order() {
    let generator: JsAsyncGenerator<f64, f64, f64> = async_generator_new(|generator, _command| {
        generator_suspend(&generator, |_generator, command| match command {
            GeneratorCommand::Next(value) => {
                GeneratorStep::Returned(Some(async_generator_input::<f64>(value)))
            }
            GeneratorCommand::Return(value) => GeneratorStep::Returned(value),
            GeneratorCommand::Throw(reason) => rethrow_caught(reason),
        });
        GeneratorStep::Yielded(AsyncGeneratorYield::Value(1.0))
    });

    let first = async_generator_next(&generator, 0.0);
    let second = async_generator_next(&generator, 5.0);
    let third = async_generator_next(&generator, 9.0);

    assert!(async_generator_ptr_eq(&generator, &generator.clone()));
    assert!(matches!(promise_poll(&first), Some(Ok(AsyncGeneratorStep::Yielded(1.0)))));
    assert!(matches!(promise_poll(&second), Some(Ok(AsyncGeneratorStep::Returned(Some(5.0))))));
    assert!(matches!(promise_poll(&third), Some(Ok(AsyncGeneratorStep::Returned(None)))));
}

#[test]
fn async_generator_parks_on_await_and_resumes_with_the_settled_value() {
    let gate: JsPromise<f64> = promise_new();
    let awaited = gate.clone();
    let generator: JsAsyncGenerator<f64, f64, ()> = async_generator_new(move |generator, _command| {
        generator_suspend(&generator, |generator, command| match command {
            GeneratorCommand::Next(value) => {
                let resolved = async_generator_input::<f64>(value);
                generator_suspend(&generator, |_generator, command| match command {
                    GeneratorCommand::Next(_) => GeneratorStep::Returned(Some(-1.0)),
                    GeneratorCommand::Return(value) => GeneratorStep::Returned(value),
                    GeneratorCommand::Throw(reason) => rethrow_caught(reason),
                });
                GeneratorStep::Yielded(AsyncGeneratorYield::Value(resolved * 2.0))
            }
            GeneratorCommand::Return(value) => GeneratorStep::Returned(value),
            GeneratorCommand::Throw(reason) => rethrow_caught(reason),
        });
        GeneratorStep::Yielded(async_generator_await(awaited))
    });

    let first = async_generator_next(&generator, ());
    let returned = async_generator_return(&generator, Some(8.0));
    assert!(promise_poll(&first).is_none());
    assert!(promise_poll(&returned).is_none());

    let _ = promise_fulfill(&gate, 21.0);
    run_event_loop();

    assert!(matches!(promise_poll(&first), Some(Ok(AsyncGeneratorStep::Yielded(42.0)))));
    assert!(matches!(promise_poll(&returned), Some(Ok(AsyncGeneratorStep::Returned(Some(8.0))))));
}
