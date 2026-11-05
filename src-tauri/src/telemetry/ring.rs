// Fixed-capacity ring buffer — VecDeque port of src/server/ring-buffer.ts
// (SPEC-PHASE4 §3). Drops oldest beyond capacity; tail(n) returns the last n
// items oldest → newest.

use std::collections::VecDeque;

pub struct RingBuffer<T> {
    cap: usize,
    buf: VecDeque<T>,
}

impl<T: Clone> RingBuffer<T> {
    pub fn new(cap: usize) -> Self {
        RingBuffer { cap: cap.max(1), buf: VecDeque::new() }
    }

    pub fn push(&mut self, item: T) {
        if self.buf.len() == self.cap {
            self.buf.pop_front();
        }
        self.buf.push_back(item);
    }

    pub fn tail(&self, n: Option<usize>) -> Vec<T> {
        match n {
            None => self.buf.iter().cloned().collect(),
            Some(n) if n == 0 => Vec::new(),
            Some(n) => {
                let skip = self.buf.len().saturating_sub(n);
                self.buf.iter().skip(skip).cloned().collect()
            }
        }
    }

    #[allow(dead_code)] // part of the ring.rs contract (SPEC-PHASE4 §3); used in tests
    pub fn len(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_oldest_and_tails() {
        let mut r: RingBuffer<u32> = RingBuffer::new(3);
        for i in 0..5 {
            r.push(i);
        }
        assert_eq!(r.len(), 3);
        assert_eq!(r.tail(None), vec![2, 3, 4]);
        assert_eq!(r.tail(Some(2)), vec![3, 4]);
        assert_eq!(r.tail(Some(0)), Vec::<u32>::new());
        assert_eq!(r.tail(Some(99)), vec![2, 3, 4]);
    }
}
