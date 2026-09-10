// @no-engine
try { await Promise.reject("reason"); } catch (error) { console.log(typeof error, error); }
try { await Promise.reject(42); } catch (error) { console.log(typeof error, error); }
try { await Promise.reject(false); } catch (error) { console.log(typeof error, error); }
try { await Promise.reject(null); } catch (error) { console.log(typeof error, error); }
try { await Promise.reject(undefined); } catch (error) { console.log(typeof error, error); }
