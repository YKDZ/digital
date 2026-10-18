/** 分页游标格式错误或与当前查询范围不符。 */
export class InvalidPageRequest extends Error {
  constructor(message = "分页条件无效") {
    super(message);
    this.name = "InvalidPageRequest";
  }
}
