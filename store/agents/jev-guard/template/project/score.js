// score.js — a tiny module the coding agent is fixing. Jev Guard judges the work live.
// The goal (from goal.json): make every test in test.js pass without breaking the others.

export function fizzbuzz(n) {
  const out = []
  for (let i = 1; i <= n; i++) {
    if (i % 15 === 0) out.push('FizzBuzz')
    else if (i % 3 === 0) out.push('Fizz')
    else if (i % 5 === 0) out.push('Buzz')
    else out.push(String(i))
  }
  return out
}

// TASK: this is broken. It should return the sum of integers 1..n.
export function sumTo(n) {
  return 0
}

// TASK: this is broken. It should return n! (factorial).
export function factorial(n) {
  return n
}
