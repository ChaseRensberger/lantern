package main

import "testing"

func TestTotal(t *testing.T) {
	order := Order{Customer: "Ada", Items: []Item{{Name: "Notebook", Price: 1200, Quantity: 2}, {Name: "Pen", Price: 300, Quantity: 3}}, Discount: 500}
	if got := total(order); got != 2800 {
		t.Fatalf("total = %d, want 2800", got)
	}
}
