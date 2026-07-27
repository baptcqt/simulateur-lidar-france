from simmap.vegetation.segment import demo_trees
def test_multiple_trees():
 trees=demo_trees(); assert len(trees)>=2; assert all(len(m.vertices)>10 for _,m,_ in trees)
