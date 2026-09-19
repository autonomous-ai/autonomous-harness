// test.js — the test suite. Jev Guard runs it on every edit. Make every assert pass.
import assert from 'node:assert/strict'
import { fizzbuzz, sumTo, factorial } from './score.js'

assert.deepEqual(fizzbuzz(15), [
  '1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz', 'Buzz',
  '11', 'Fizz', '13', '14', 'FizzBuzz',
])
assert.equal(fizzbuzz(1).length, 1)

assert.equal(sumTo(1), 1)
assert.equal(sumTo(5), 15)
assert.equal(sumTo(100), 5050)

assert.equal(factorial(0), 1)
assert.equal(factorial(5), 120)
assert.equal(factorial(10), 3628800)

console.log('ALL TESTS PASS')
