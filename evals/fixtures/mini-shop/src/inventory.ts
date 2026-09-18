export interface Item {
  id: string;
  price: number;
}

// TODO: 库存扣减
export function deduct(stock: number, qty: number): number {
  return stock - qty;
}
