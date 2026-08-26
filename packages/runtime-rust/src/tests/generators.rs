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
